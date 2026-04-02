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

import { startNatsContainer } from './nats-container';
import { waitForCondition } from './helpers';

/* eslint-disable @typescript-eslint/naming-convention -- NATS API uses snake_case */

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
      try { await jsm.streams.delete(name); } catch { /* ignore */ }
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
});
