import { Controller } from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';

import {
  AckPolicy,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
  type StreamConfig,
} from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';

import { faker } from '@faker-js/faker';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  consumerName,
  dlqStreamName,
  JetstreamMigrationError,
  MigrationErrorReason,
  StreamKind,
  streamName,
} from '../../src';
import {
  MIGRATION_BACKUP_SUFFIX,
  MIGRATION_HEARTBEAT_KEY,
  MIGRATION_PAUSED_CONSUMERS_KEY,
  MIGRATION_PHASE_KEY,
  MigrationPhase,
  StreamMigration,
} from '../../src/server/infrastructure';
import { cleanupStreams, createTestApp, uniqueServiceName, waitForCondition } from './helpers';
import { startNatsContainer } from './nats-container';

/** Fast enough for a test, the same ratios as production. */
const FAST = { heartbeatIntervalMs: 100, abandonedAfterMs: 600, stallTimeoutMs: 5_000 };

@Controller()
class OrdersController {
  @EventPattern<string>('order.created')
  public handle(): void {}
}

type DesiredStream = Partial<StreamConfig> & { name: string; subjects: string[] };

type StreamsCall = (...args: unknown[]) => Promise<unknown>;

/** Wraps one `jsm.streams` call; lets a test stall an instance the way a network partition would. */
type StreamsInterceptor = (
  method: PropertyKey,
  args: unknown[],
  call: () => Promise<unknown>,
) => Promise<unknown>;

const intercepted = (target: JetStreamManager, around: StreamsInterceptor): JetStreamManager => {
  const streams = new Proxy(target.streams, {
    get: (obj, method, receiver): unknown => {
      const value: unknown = Reflect.get(obj, method, receiver);

      if (typeof value !== 'function') return value;

      return (...args: unknown[]): Promise<unknown> =>
        around(method, args, () => (value as StreamsCall).apply(obj, args));
    },
  });

  return new Proxy(target, {
    get: (obj, prop, receiver) => (prop === 'streams' ? streams : Reflect.get(obj, prop, receiver)),
  });
};

describe('Stream migration lock', () => {
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  let js: JetStreamClient;
  let container: StartedTestContainer;
  let port: number;
  let stream: string;

  beforeAll(async () => {
    const started = await startNatsContainer();

    container = started.container;
    port = started.port;
    nc = await connect({ servers: [`nats://localhost:${started.port}`] });
    jsm = await jetstreamManager(nc);
    js = jetstream(nc);
  });

  afterAll(async () => {
    await nc.drain();
    await container.stop();
  });

  afterEach(async () => {
    for (const name of [stream, `${stream}${MIGRATION_BACKUP_SUFFIX}`]) {
      await jsm.streams.delete(name).catch(() => undefined);
    }
  });

  /** A file-backed work-queue stream holding `count` messages, and the memory config it migrates to. */
  const seedStream = async (count: number): Promise<DesiredStream> => {
    stream = `mig-${faker.string.alphanumeric(8).toLowerCase()}`;

    const subjects = [`${stream}.>`];

    await jsm.streams.add({
      name: stream,
      subjects,
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
    });

    for (let i = 0; i < count; i++) await js.publish(`${stream}.order`, String(i));

    return {
      name: stream,
      subjects,
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.Memory,
    };
  };

  const backupOf = (name: string): string => `${name}${MIGRATION_BACKUP_SUFFIX}`;

  /** A backup as a migrating instance leaves it, holding `count` messages of its own. */
  const createBackup = async (
    count: number,
    metadata: Record<string, string>,
    staging = `${backupOf(stream)}.staging`,
  ): Promise<void> => {
    const backup = backupOf(stream);

    await jsm.streams.add({
      name: backup,
      subjects: [staging],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      metadata,
    });

    for (let i = 0; i < count; i++) await js.publish(staging, String(i));

    const info = await jsm.streams.info(backup);

    await jsm.streams.update(backup, { ...info.config, subjects: [] });
  };

  const live = (phase: MigrationPhase): Record<string, string> => ({
    [MIGRATION_PHASE_KEY]: phase,
    [MIGRATION_HEARTBEAT_KEY]: '0',
  });

  it('should keep every message when two instances migrate the same stream at once', async () => {
    // Given: two pods of a rolling deploy start with the same immutable change
    const desired = await seedStream(500);

    // When
    const outcomes = await Promise.allSettled([
      new StreamMigration().migrate(jsm, stream, desired),
      new StreamMigration().migrate(jsm, stream, desired),
    ]);

    // Then: both finish, the stream is migrated once, and nothing is lost
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);

    const info = await jsm.streams.info(stream);

    expect(info.config.storage).toBe(StorageType.Memory);
    expect(info.state.messages).toBe(500);
    await expect(jsm.streams.info(`${stream}${MIGRATION_BACKUP_SUFFIX}`)).rejects.toThrow(
      /not found/,
    );
  });

  it('should not delete the original once a stalled owner wakes up after a takeover', async () => {
    // Given: the owner is cut off from NATS right after it starts the backup
    const desired = await seedStream(200);
    const deletedByOwner: unknown[] = [];
    let partition: Promise<void> = Promise.resolve();
    let partitioned = false;
    let heal = (): void => {};

    const owner = intercepted(jsm, async (method, args, call) => {
      await partition;

      if (method === 'delete') deletedByOwner.push(args[0]);

      const result = await call();
      const [name, config] = args as [string, Partial<StreamConfig> | undefined];

      if (
        !partitioned &&
        method === 'update' &&
        name === backupOf(stream) &&
        config?.sources?.length
      ) {
        partitioned = true;
        partition = new Promise((resolve) => {
          heal = resolve;
        });
      }

      return result;
    });
    const ownerOutcome = new StreamMigration(FAST)
      .migrate(owner, stream, desired)
      .then(() => null)
      .catch((err: unknown) => err);

    await waitForCondition(() => partitioned, 5_000);

    // When: another instance takes the migration over, and the owner comes
    // back while the taker is about to purge the original
    let takerStalled: Promise<unknown> | undefined;
    const taker = intercepted(jsm, async (method, args, call) => {
      if (takerStalled === undefined && method === 'purge' && args[0] === stream) {
        takerStalled = ownerOutcome;
        heal();
      }

      if (takerStalled !== undefined) await takerStalled;

      return call();
    });
    const recovered = await new StreamMigration(FAST).settle(taker, stream, desired);

    // Then: the stale owner stood down without deleting, and nothing is lost
    expect(await ownerOutcome).toMatchObject({ reason: MigrationErrorReason.LockLost });
    expect(deletedByOwner).not.toContain(stream);
    expect(recovered).toBe(true);
    expect((await jsm.streams.info(stream)).state.messages).toBe(200);
    await expect(jsm.streams.info(backupOf(stream))).rejects.toThrow(/not found/);
  });

  it('should wait for a live migration without touching its backup', async () => {
    // Given: a peer is mid-migration and keeps its heartbeat going for a while
    await seedStream(10);
    await createBackup(10, live(MigrationPhase.Backup));

    let beats = 0;
    const heartbeat = setInterval(() => {
      beats += 1;
      void jsm.streams.info(backupOf(stream)).then((info) =>
        jsm.streams.update(backupOf(stream), {
          ...info.config,
          metadata: { ...info.config.metadata, [MIGRATION_HEARTBEAT_KEY]: String(beats) },
        }),
      );
    }, 100);

    setTimeout(() => {
      clearInterval(heartbeat);
      void jsm.streams.delete(backupOf(stream));
    }, 1_500);

    const startedAt = Date.now();

    // When
    const recovered = await new StreamMigration(FAST).settle(jsm, stream, {
      name: stream,
      subjects: [`${stream}.>`],
    });

    // Then: it waited for the peer to finish rather than recovering its backup
    expect(recovered).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
    expect((await jsm.streams.info(stream)).state.messages).toBe(10);
  });

  it('should finish an abandoned migration once its heartbeat stops', async () => {
    // Given: the migrating instance died after deleting the original
    stream = `mig-${faker.string.alphanumeric(8).toLowerCase()}`;
    await createBackup(25, live(MigrationPhase.Restore));

    // When
    const recovered = await new StreamMigration(FAST).settle(jsm, stream, {
      name: stream,
      subjects: [`${stream}.>`],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.Memory,
    });

    // Then
    expect(recovered).toBe(true);

    const info = await jsm.streams.info(stream);

    expect(info.config.storage).toBe(StorageType.Memory);
    expect(info.state.messages).toBe(25);
    await expect(jsm.streams.info(backupOf(stream))).rejects.toThrow(/not found/);
  });

  it('should give back every message, once, when a migration died before deleting the original', async () => {
    // Given: a consumer covers only half the subjects, so sourcing copies those
    // and moves the rest out of the original
    const desired = await seedStream(0);

    await jsm.consumers.add(stream, {
      durable_name: 'orders-a',
      ack_policy: AckPolicy.Explicit,
      filter_subject: `${stream}.a`,
    });

    for (let i = 0; i < 5; i++) {
      await js.publish(`${stream}.a`, String(i));
      await js.publish(`${stream}.b`, String(i));
    }

    const info = await jsm.streams.info(stream);

    await jsm.streams.update(stream, { ...info.config, subjects: [] });
    await jsm.streams.add({
      ...info.config,
      name: backupOf(stream),
      subjects: [],
      sources: [{ name: stream }],
      metadata: live(MigrationPhase.Backup),
    });
    await waitForCondition(
      async () => (await jsm.streams.info(backupOf(stream))).state.messages === 10,
      5_000,
    );
    // The server removes what sourcing moved out shortly after the copy
    await waitForCondition(
      async () => (await jsm.streams.info(stream)).state.messages === 5,
      5_000,
    );

    // When
    await new StreamMigration(FAST).settle(jsm, stream, desired);

    // Then: the moved half is back and the copied half is not doubled
    expect((await jsm.streams.info(stream)).state.messages).toBe(10);
    await expect(jsm.streams.info(backupOf(stream))).rejects.toThrow(/not found/);
  });

  it('should refuse a migration whose new limits cannot hold the messages, before deleting anything', async () => {
    // Given
    const desired = await seedStream(20);

    // When
    const failure = await new StreamMigration(FAST)
      .migrate(jsm, stream, { ...desired, max_msgs: 10 })
      .catch((err: unknown) => err);

    // Then: the original is untouched and accepts publishes again
    expect(failure).toBeInstanceOf(JetstreamMigrationError);
    expect(failure).toMatchObject({ reason: MigrationErrorReason.InsufficientCapacity });

    const info = await jsm.streams.info(stream);

    expect(info.config.storage).toBe(StorageType.File);
    expect(info.config.subjects).toEqual([`${stream}.>`]);
    expect(info.state.messages).toBe(20);
    await expect(jsm.streams.info(backupOf(stream))).rejects.toThrow(/not found/);
  });

  it('should refuse a migration whose per-subject limit cannot hold a subject, before deleting anything', async () => {
    // Given: every message on one subject
    const desired = await seedStream(20);

    // When
    const failure = await new StreamMigration(FAST)
      .migrate(jsm, stream, { ...desired, max_msgs_per_subject: 10 })
      .catch((err: unknown) => err);

    // Then
    expect(failure).toBeInstanceOf(JetstreamMigrationError);
    expect(failure).toMatchObject({ reason: MigrationErrorReason.InsufficientCapacity });
    expect((failure as Error).message).toContain(`${stream}.order`);

    const info = await jsm.streams.info(stream);

    expect(info.config.storage).toBe(StorageType.File);
    expect(info.config.subjects).toEqual([`${stream}.>`]);
    expect(info.state.messages).toBe(20);
    await expect(jsm.streams.info(backupOf(stream))).rejects.toThrow(/not found/);
  });

  it('should migrate when every subject fits a lowered per-subject limit', async () => {
    // Given
    const desired = await seedStream(10);

    // When
    await new StreamMigration(FAST).migrate(jsm, stream, { ...desired, max_msgs_per_subject: 10 });

    // Then
    const info = await jsm.streams.info(stream);

    expect(info.config.storage).toBe(StorageType.Memory);
    expect(info.state.messages).toBe(10);
  });

  it('should migrate a work-queue stream that another replica keeps consuming, without duplicates', async () => {
    // Given: an old replica consumes the stream while the migration runs
    const total = 60;
    const desired = await seedStream(total);
    const durable = 'old-replica';

    await jsm.consumers.add(stream, {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      filter_subject: `${stream}.>`,
    });

    const processed: string[] = [];
    const stop = new AbortController();
    const oldReplica = (async (): Promise<void> => {
      const consumer = await js.consumers.get(stream, durable);

      while (!stop.signal.aborted) {
        const msg = await consumer.next({ expires: 1_000 }).catch(() => null);

        if (msg === null) continue;

        await new Promise((r) => setTimeout(r, 30));
        processed.push(msg.string());
        await msg.ackAck().catch(() => undefined);
      }
    })();

    await waitForCondition(() => processed.length >= 3, 5_000);

    // When
    const outcome = await new StreamMigration(FAST)
      .migrate(jsm, stream, desired)
      .then(() => null)
      .catch((err: unknown) => err);

    stop.abort();
    await oldReplica;

    // Then: every message is either processed or restored, never both
    expect(outcome).toBeNull();

    const info = await jsm.streams.info(stream);
    const restored: string[] = [];

    for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq++) {
      const stored = await jsm.streams.getMessage(stream, { seq });

      if (stored !== null) restored.push(stored.string());
    }

    expect(info.config.storage).toBe(StorageType.Memory);
    expect(restored.filter((m) => processed.includes(m))).toEqual([]);
    expect(new Set([...processed, ...restored]).size).toBe(total);
  }, 30_000);

  it('should resume the consumers it paused when the migration is refused', async () => {
    // Given
    const desired = await seedStream(20);

    await jsm.consumers.add(stream, {
      durable_name: 'worker',
      ack_policy: AckPolicy.Explicit,
      filter_subject: `${stream}.>`,
    });

    // When
    await new StreamMigration(FAST)
      .migrate(jsm, stream, { ...desired, max_msgs: 10 })
      .catch(() => undefined);

    // Then
    expect((await jsm.consumers.info(stream, 'worker')).paused).toBeFalsy();
  });

  it('should resume consumers an abandoned migration paused', async () => {
    // Given: the migrating instance paused a consumer and died before deleting the original
    await seedStream(5);
    await jsm.consumers.add(stream, {
      durable_name: 'worker',
      ack_policy: AckPolicy.Explicit,
      filter_subject: `${stream}.>`,
    });
    await jsm.consumers.pause(stream, 'worker', new Date(Date.now() + 3_600_000));
    await createBackup(0, {
      ...live(MigrationPhase.Backup),
      [MIGRATION_PAUSED_CONSUMERS_KEY]: JSON.stringify(['worker']),
    });

    // When
    await new StreamMigration(FAST).settle(jsm, stream, {
      name: stream,
      subjects: [`${stream}.>`],
    });

    // Then
    expect((await jsm.consumers.info(stream, 'worker')).paused).toBeFalsy();
    expect((await jsm.streams.info(stream)).state.messages).toBe(5);
  });

  it('should refuse to migrate a stream that allows message schedules and holds messages', async () => {
    // Given: an event stream with schedules on, holding a message nobody consumed yet
    const serviceName = uniqueServiceName();

    stream = streamName(serviceName, StreamKind.Event);

    const first = await createTestApp(
      { name: serviceName, port, events: { stream: { allow_msg_schedules: true } } },
      [OrdersController],
    );

    await first.app.close();
    await jsm.consumers.delete(stream, consumerName(serviceName, StreamKind.Event));

    const { config } = await jsm.streams.info(stream);

    await js.publish(config.subjects[0]!.replace('>', 'order.created'), '{}');

    // When: the next deploy changes an immutable property
    const failure = await createTestApp(
      {
        name: serviceName,
        port,
        provisioning: { allowDestructiveMigration: true },
        events: { stream: { allow_msg_schedules: true, storage: StorageType.Memory } },
      },
      [OrdersController],
    ).catch((err: unknown) => err);

    // Then
    try {
      expect(failure).toBeInstanceOf(JetstreamMigrationError);
      expect(failure).toMatchObject({ reason: MigrationErrorReason.MessageSchedules });

      const info = await jsm.streams.info(stream);

      expect(info.config.storage).toBe(StorageType.File);
      expect(info.config.subjects).toEqual(config.subjects);
      expect(info.state.messages).toBe(1);
      await expect(jsm.streams.info(backupOf(stream))).rejects.toThrow(/not found/);
    } finally {
      await cleanupStreams(nc, serviceName);
    }
  });

  it('should refuse a migration into a stream that allows message schedules, before deleting anything', async () => {
    // Given
    const desired = await seedStream(5);

    // When
    const failure = await new StreamMigration(FAST)
      .migrate(jsm, stream, { ...desired, allow_msg_schedules: true })
      .catch((err: unknown) => err);

    // Then: the original is reopened with every message
    expect(failure).toMatchObject({ reason: MigrationErrorReason.MessageSchedules });

    const info = await jsm.streams.info(stream);

    expect(info.config.subjects).toEqual([`${stream}.>`]);
    expect(info.state.messages).toBe(5);
    await expect(jsm.streams.info(backupOf(stream))).rejects.toThrow(/not found/);
  });

  it('should finish a restore stuck on a stream that allows message schedules', async () => {
    // Given: an older release deleted the original and recreated it with
    // schedules on, so the backup cannot be sourced back
    stream = `mig-${faker.string.alphanumeric(8).toLowerCase()}`;

    const desired: DesiredStream = {
      name: stream,
      subjects: [`${stream}.>`],
      retention: RetentionPolicy.Workqueue,
      allow_msg_schedules: true,
    };

    await createBackup(25, live(MigrationPhase.Restore), `${stream}.order`);
    await jsm.streams.add(desired);
    await js.publish(`${stream}.order`, 'published-after-recreate');

    // When
    const recovered = await new StreamMigration(FAST).settle(jsm, stream, desired);

    // Then
    expect(recovered).toBe(true);

    const info = await jsm.streams.info(stream);

    expect(info.config.allow_msg_schedules).toBe(true);
    expect(info.config.sources ?? []).toEqual([]);
    expect(info.state.messages).toBe(26);
    await expect(jsm.streams.info(backupOf(stream))).rejects.toThrow(/not found/);
  });

  it('should republish distinct messages that share a message id', async () => {
    // Given: two backed-up messages published with the same id outside the dedup window
    stream = `mig-${faker.string.alphanumeric(8).toLowerCase()}`;

    const desired: DesiredStream = {
      name: stream,
      subjects: [`${stream}.>`],
      retention: RetentionPolicy.Workqueue,
      allow_msg_schedules: true,
    };

    await jsm.streams.add({
      name: backupOf(stream),
      subjects: [`${stream}.order`],
      retention: RetentionPolicy.Workqueue,
      duplicate_window: 100_000_000,
      metadata: live(MigrationPhase.Restore),
    });
    await js.publish(`${stream}.order`, 'first', { msgID: 'order-1' });
    await new Promise((r) => setTimeout(r, 300));
    await js.publish(`${stream}.order`, 'second', { msgID: 'order-1' });

    const { config } = await jsm.streams.info(backupOf(stream));

    await jsm.streams.update(backupOf(stream), { ...config, subjects: [] });
    await jsm.streams.add(desired);

    // When
    await new StreamMigration(FAST).settle(jsm, stream, desired);

    // Then
    expect((await jsm.streams.info(stream)).state.messages).toBe(2);
  });

  it('should not republish what it already did when a stuck restore is resumed after a crash', async () => {
    // Given: a stuck restore into a stream whose dedup window is long gone
    stream = `mig-${faker.string.alphanumeric(8).toLowerCase()}`;

    const desired: DesiredStream = {
      name: stream,
      subjects: [`${stream}.>`],
      retention: RetentionPolicy.Workqueue,
      allow_msg_schedules: true,
      duplicate_window: 100_000_000,
    };

    await createBackup(10, live(MigrationPhase.Restore), `${stream}.order`);
    await jsm.streams.add(desired);

    let reads = 0;
    const crashing = intercepted(jsm, async (method, _args, call) => {
      if (method === 'getMessage' && ++reads > 4) throw new Error('process killed');

      return call();
    });

    await new StreamMigration(FAST).settle(crashing, stream, desired).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));

    // When
    await new StreamMigration(FAST).settle(jsm, stream, desired);

    // Then
    expect((await jsm.streams.info(stream)).state.messages).toBe(10);
    await expect(jsm.streams.info(backupOf(stream))).rejects.toThrow(/not found/);
  });

  it('should resume an interrupted migration of the DLQ stream on boot', async () => {
    // Given: a DLQ migration by an older release died between deleting and
    // recreating the stream, long enough ago to count as abandoned
    const serviceName = uniqueServiceName();

    stream = dlqStreamName(serviceName);
    await createBackup(3, {
      'nestjs-jetstream-migration-started-at': new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    // When
    const { app } = await createTestApp({ name: serviceName, port, dlq: {} }, [OrdersController]);

    // Then
    try {
      expect((await jsm.streams.info(stream)).state.messages).toBe(3);
      await expect(jsm.streams.info(backupOf(stream))).rejects.toThrow(/not found/);
    } finally {
      await app.close();
      await cleanupStreams(nc, serviceName);
    }
  });
});
