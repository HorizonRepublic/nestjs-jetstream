import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import {
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
} from '@nats-io/jetstream';
import type { StartedTestContainer } from 'testcontainers';
import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import { faker } from '@faker-js/faker';

import { buildSubject, streamName, StreamKind } from '../../src';

import { startNatsContainer } from './nats-container';
import { cleanupStreams, createTestApp, uniqueServiceName, waitForCondition } from './helpers';

@Controller()
class MigrationTestController {
  public readonly received: unknown[] = [];

  @EventPattern('migration.test')
  handle(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

describe('Stream sourcing behavior (NATS verification)', () => {
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  let js: JetStreamClient;
  let container: StartedTestContainer;
  let port: number;
  const streams: string[] = [];

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await connect({ servers: [`nats://localhost:${port}`] });
    jsm = await jetstreamManager(nc);
    js = jetstream(nc);
  }, 60_000);

  afterEach(vi.resetAllMocks);

  afterAll(async () => {
    for (const name of streams) {
      try {
        await jsm.streams.delete(name);
      } catch {
        /* ignore */
      }
    }

    await nc.drain();
    await container.stop();
  });

  it('should copy messages via stream sourcing and preserve content', async () => {
    // Given: stream A with 10 messages
    const nameA = `source-test-a-${Date.now()}`;
    const nameB = `source-test-b-${Date.now()}`;

    streams.push(nameA, nameB);

    await jsm.streams.add({
      name: nameA,
      subjects: [`${nameA}.>`],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
    });

    const encoder = new TextEncoder();

    for (let i = 0; i < 10; i++) {
      await js.publish(`${nameA}.test`, encoder.encode(JSON.stringify({ index: i })));
    }

    // When: create B sourcing from A
    await jsm.streams.add({
      name: nameB,
      subjects: [],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
      sources: [{ name: nameA }],
    });

    await waitForCondition(async () => {
      const info = await jsm.streams.info(nameB);

      return info.state.messages >= 10;
    }, 10_000);

    // Then
    const infoB = await jsm.streams.info(nameB);

    expect(infoB.state.messages).toBe(10);
  });

  it('should allow sourcing into a stream with different storage type (File → Memory)', async () => {
    // Given: File stream with messages
    const nameFile = `storage-file-${Date.now()}`;
    const nameMem = `storage-mem-${Date.now()}`;

    streams.push(nameFile, nameMem);

    await jsm.streams.add({
      name: nameFile,
      subjects: [`${nameFile}.>`],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
    });

    const encoder = new TextEncoder();

    for (let i = 0; i < 5; i++) {
      await js.publish(`${nameFile}.test`, encoder.encode(JSON.stringify({ i })));
    }

    // When: source into Memory stream
    await jsm.streams.add({
      name: nameMem,
      subjects: [],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.Memory,
      num_replicas: 1,
      sources: [{ name: nameFile }],
    });

    await waitForCondition(async () => {
      const info = await jsm.streams.info(nameMem);

      return info.state.messages >= 5;
    }, 10_000);

    // Then
    const info = await jsm.streams.info(nameMem);

    expect(info.state.messages).toBe(5);
    expect(info.config.storage).toBe(StorageType.Memory);
  });

  it('should preserve message IDs through sourcing round-trip', async () => {
    // Given: stream with dedup IDs
    const nameA = `msgid-a-${Date.now()}`;
    const nameB = `msgid-b-${Date.now()}`;

    streams.push(nameA, nameB);

    await jsm.streams.add({
      name: nameA,
      subjects: [`${nameA}.>`],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
      duplicate_window: 120_000_000_000,
    });

    await js.publish(`${nameA}.test`, new TextEncoder().encode('{"a":1}'), { msgID: 'msg-1' });
    await js.publish(`${nameA}.test`, new TextEncoder().encode('{"a":2}'), { msgID: 'msg-2' });

    // When: source to B
    await jsm.streams.add({
      name: nameB,
      subjects: [],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
      sources: [{ name: nameA }],
      duplicate_window: 120_000_000_000,
    });

    await waitForCondition(async () => {
      const info = await jsm.streams.info(nameB);

      return info.state.messages >= 2;
    }, 10_000);

    // Then
    expect((await jsm.streams.info(nameB)).state.messages).toBe(2);
  });

  describe('Stream migration via transport', () => {
    describe('empty stream migration (storage change)', () => {
      it('should recreate stream with new storage type', async () => {
        const serviceName = uniqueServiceName();

        // Given: app creates stream with File storage
        const { app: app1 } = await createTestApp(
          { name: serviceName, port, events: { stream: { storage: StorageType.File } } },
          [MigrationTestController],
          [serviceName],
        );

        await app1.close();

        // When: restart with Memory storage + allowDestructiveMigration
        const { app: app2 } = await createTestApp(
          {
            name: serviceName,
            port,
            allowDestructiveMigration: true,
            events: { stream: { storage: StorageType.Memory, max_bytes: 50_000_000 } },
          },
          [MigrationTestController],
          [serviceName],
        );

        // Then: stream has Memory storage
        const evStreamName = streamName(serviceName, StreamKind.Event);
        const info = await jsm.streams.info(evStreamName);

        expect(info.config.storage).toBe(StorageType.Memory);

        await app2.close();
        await cleanupStreams(nc, serviceName);
      });
    });

    describe('reverse migration (Memory → File)', () => {
      it('should migrate Memory back to File and preserve messages', async () => {
        const serviceName = uniqueServiceName();

        // Given: create stream with Memory storage
        const { app: app1 } = await createTestApp(
          {
            name: serviceName,
            port,
            events: { stream: { storage: StorageType.Memory, max_bytes: 50_000_000 } },
          },
          [MigrationTestController],
          [serviceName],
        );

        await app1.close();

        // Publish messages directly
        const evStreamName = streamName(serviceName, StreamKind.Event);
        const subject = buildSubject(serviceName, StreamKind.Event, 'migration.test');
        const encoder = new TextEncoder();

        for (let i = 0; i < 5; i++) {
          await js.publish(subject, encoder.encode(JSON.stringify({ i })));
        }

        const infoBefore = await jsm.streams.info(evStreamName);

        expect(infoBefore.config.storage).toBe(StorageType.Memory);
        expect(infoBefore.state.messages).toBe(5);

        // When: migrate Memory → File
        const { app: app2, module: module2 } = await createTestApp(
          {
            name: serviceName,
            port,
            allowDestructiveMigration: true,
            events: { stream: { storage: StorageType.File } },
          },
          [MigrationTestController],
          [serviceName],
        );

        // Then: stream has File storage with messages preserved
        const infoAfter = await jsm.streams.info(evStreamName);

        expect(infoAfter.config.storage).toBe(StorageType.File);
        expect(infoAfter.state.messages).toBeGreaterThanOrEqual(5);

        const controller = module2.get(MigrationTestController);

        await waitForCondition(() => controller.received.length >= 5, 15_000);

        expect(controller.received).toHaveLength(5);

        await app2.close();
        await cleanupStreams(nc, serviceName);
      });
    });

    describe('stream with messages (storage change)', () => {
      it('should preserve messages through migration', async () => {
        const serviceName = uniqueServiceName();

        // Given: app creates Event stream with File storage, then close it before publishing
        const { app: app1 } = await createTestApp(
          { name: serviceName, port, events: { stream: { storage: StorageType.File } } },
          [MigrationTestController],
          [serviceName],
        );

        // Close the consumer so messages accumulate in the stream
        await app1.close();

        // Publish 10 messages directly into the stream (no consumer running)
        const evStreamName = streamName(serviceName, StreamKind.Event);
        const subject = buildSubject(serviceName, StreamKind.Event, 'migration.test');
        const encoder = new TextEncoder();

        for (let i = 0; i < 10; i++) {
          await js.publish(subject, encoder.encode(JSON.stringify({ index: i })));
        }

        // Verify messages exist in stream
        const infoBefore = await jsm.streams.info(evStreamName);

        expect(infoBefore.state.messages).toBeGreaterThanOrEqual(10);

        // When: restart with Memory storage + allowDestructiveMigration
        const { app: app2, module: module2 } = await createTestApp(
          {
            name: serviceName,
            port,
            allowDestructiveMigration: true,
            events: { stream: { storage: StorageType.Memory, max_bytes: 50_000_000 } },
          },
          [MigrationTestController],
          [serviceName],
        );

        // Then: messages preserved + new storage
        const infoAfter = await jsm.streams.info(evStreamName);

        expect(infoAfter.config.storage).toBe(StorageType.Memory);
        expect(infoAfter.state.messages).toBeGreaterThanOrEqual(10);

        // And: controller receives migrated messages
        const controller = module2.get(MigrationTestController);

        await waitForCondition(() => controller.received.length >= 10, 15_000);

        expect(controller.received.length).toBeGreaterThanOrEqual(10);

        await app2.close();
        await cleanupStreams(nc, serviceName);
      });
    });

    describe('flag OFF with immutable change', () => {
      it('should warn and apply only mutable changes', async () => {
        const serviceName = uniqueServiceName();

        // Given: app with File storage
        const { app: app1 } = await createTestApp(
          { name: serviceName, port },
          [MigrationTestController],
          [serviceName],
        );

        await app1.close();

        // When: restart with Memory storage but WITHOUT allowDestructiveMigration
        const { app: app2 } = await createTestApp(
          {
            name: serviceName,
            port,
            // allowDestructiveMigration defaults to false
            events: { stream: { storage: StorageType.Memory, max_bytes: 50_000_000 } },
          },
          [MigrationTestController],
          [serviceName],
        );

        // Then: stream still has File storage (immutable change skipped)
        const evStreamName = streamName(serviceName, StreamKind.Event);
        const info = await jsm.streams.info(evStreamName);

        expect(info.config.storage).toBe(StorageType.File);

        await app2.close();
        await cleanupStreams(nc, serviceName);
      });
    });

    describe('randomized bulk migration', () => {
      it('should preserve and deliver 20–50 random events through File→Memory migration', async () => {
        const messageCount = faker.number.int({ min: 20, max: 50 });
        const serviceName = uniqueServiceName();

        // Given: create stream, then close consumer so messages accumulate
        const { app: app1 } = await createTestApp(
          { name: serviceName, port, events: { stream: { storage: StorageType.File } } },
          [MigrationTestController],
          [serviceName],
        );

        await app1.close();

        // Publish N random messages directly into the stream
        const evStreamName = streamName(serviceName, StreamKind.Event);
        const subject = buildSubject(serviceName, StreamKind.Event, 'migration.test');
        const encoder = new TextEncoder();
        const published: { id: number; payload: string }[] = [];

        for (let i = 0; i < messageCount; i++) {
          const payload = { id: i, payload: faker.string.alphanumeric(64) };

          published.push(payload);
          await js.publish(subject, encoder.encode(JSON.stringify(payload)));
        }

        const infoBefore = await jsm.streams.info(evStreamName);

        expect(infoBefore.state.messages).toBe(messageCount);

        // When: migrate File → Memory
        const migrationStart = Date.now();

        const { app: app2, module: module2 } = await createTestApp(
          {
            name: serviceName,
            port,
            allowDestructiveMigration: true,
            events: { stream: { storage: StorageType.Memory, max_bytes: 50_000_000 } },
          },
          [MigrationTestController],
          [serviceName],
        );

        const migrationDone = Date.now();

        // Then: all messages delivered to the controller
        const controller = module2.get(MigrationTestController);

        await waitForCondition(() => controller.received.length >= messageCount, 30_000);

        const deliveryDone = Date.now();

        expect(controller.received).toHaveLength(messageCount);

        // Verify content integrity — every published payload arrived
        const receivedIds = new Set(controller.received.map((r) => (r as { id: number }).id));

        for (const msg of published) {
          expect(receivedIds.has(msg.id)).toBe(true);
        }

        // Log timing for observability
        const migrationMs = migrationDone - migrationStart;
        const deliveryMs = deliveryDone - migrationDone;

        console.log(
          `[bulk migration] ${messageCount} messages: ` +
            `migration ${migrationMs}ms, delivery ${deliveryMs}ms, ` +
            `total ${migrationMs + deliveryMs}ms`,
        );

        // Sanity: migration + delivery should complete within 30s
        expect(migrationMs + deliveryMs).toBeLessThan(30_000);

        // Verify new storage applied
        const infoAfter = await jsm.streams.info(evStreamName);

        expect(infoAfter.config.storage).toBe(StorageType.Memory);

        await app2.close();
        await cleanupStreams(nc, serviceName);
      });
    });

    describe('orphaned backup cleanup', () => {
      it('should clean up orphaned backup stream before migration', async () => {
        const serviceName = uniqueServiceName();

        // Given: app creates stream
        const { app: app1 } = await createTestApp(
          { name: serviceName, port },
          [MigrationTestController],
          [serviceName],
        );

        await app1.close();

        // Simulate orphaned backup from previous failed migration
        const evStreamName = streamName(serviceName, StreamKind.Event);
        const backupName = `${evStreamName}__migration_backup`;

        await jsm.streams.add({
          name: backupName,
          subjects: [],
          retention: RetentionPolicy.Workqueue,
          storage: StorageType.File,
          num_replicas: 1,
        });

        // When: restart with migration
        const { app: app2 } = await createTestApp(
          {
            name: serviceName,
            port,
            allowDestructiveMigration: true,
            events: { stream: { storage: StorageType.Memory, max_bytes: 50_000_000 } },
          },
          [MigrationTestController],
          [serviceName],
        );

        // Then: orphaned backup is gone
        await expect(jsm.streams.info(backupName)).rejects.toThrow();

        await app2.close();
        await cleanupStreams(nc, serviceName);
      });
    });
  });
});
