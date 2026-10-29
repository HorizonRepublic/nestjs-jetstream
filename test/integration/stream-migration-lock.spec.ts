import { Controller } from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';

import {
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

import { dlqStreamName, JetstreamMigrationError, MigrationErrorReason } from '../../src';
import {
  MIGRATION_BACKUP_SUFFIX,
  MIGRATION_HEARTBEAT_KEY,
  MIGRATION_PHASE_KEY,
  MigrationPhase,
  StreamMigration,
} from '../../src/server/infrastructure';
import { cleanupStreams, createTestApp, uniqueServiceName } from './helpers';
import { startNatsContainer } from './nats-container';

/** Fast enough for a test, the same ratios as production. */
const FAST = { heartbeatIntervalMs: 100, abandonedAfterMs: 600, stallTimeoutMs: 5_000 };

@Controller()
class OrdersController {
  @EventPattern<string>('order.created')
  public handle(): void {}
}

type DesiredStream = Partial<StreamConfig> & { name: string; subjects: string[] };

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

  /** A backup as a migrating instance leaves it, holding `count` messages. */
  const createBackup = async (
    phase: MigrationPhase,
    count: number,
    heartbeat: string | null = '0',
  ): Promise<void> => {
    const backup = backupOf(stream);
    const staging = `${backup}.staging`;

    await jsm.streams.add({
      name: backup,
      subjects: [staging],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      metadata: {
        [MIGRATION_PHASE_KEY]: phase,
        ...(heartbeat === null ? {} : { [MIGRATION_HEARTBEAT_KEY]: heartbeat }),
      },
    });

    for (let i = 0; i < count; i++) await js.publish(staging, String(i));

    const info = await jsm.streams.info(backup);

    await jsm.streams.update(backup, { ...info.config, subjects: [] });
  };

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

  it('should wait for a live migration without touching its backup', async () => {
    // Given: a peer is mid-migration and keeps its heartbeat going for a while
    await seedStream(10);
    await createBackup(MigrationPhase.Backup, 10);

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
    await createBackup(MigrationPhase.Restore, 25);

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

  it('should drop the backup of a migration that died before deleting the original', async () => {
    // Given: the original still holds everything, the backup only part of it
    await seedStream(30);
    await createBackup(MigrationPhase.Backup, 12);

    // When
    await new StreamMigration(FAST).settle(jsm, stream, {
      name: stream,
      subjects: [`${stream}.>`],
    });

    // Then: nothing is copied back, so nothing is duplicated
    expect((await jsm.streams.info(stream)).state.messages).toBe(30);
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

  it('should resume an interrupted migration of the DLQ stream on boot', async () => {
    // Given: a DLQ migration died between deleting and recreating the stream,
    // leaving a backup without a heartbeat, as an older release would
    const serviceName = uniqueServiceName();

    stream = dlqStreamName(serviceName);
    await createBackup(MigrationPhase.Restore, 3, null);

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
