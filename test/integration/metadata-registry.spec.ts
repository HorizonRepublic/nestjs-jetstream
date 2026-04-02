import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import type { NatsConnection } from '@nats-io/transport-node';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { KV } from '@nats-io/kv';
import { Kvm } from '@nats-io/kv';
import type { StartedTestContainer } from 'testcontainers';

import { DEFAULT_METADATA_BUCKET, metadataKey, StreamKind } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

// ---------------------------------------------------------------------------
// Test metadata
// ---------------------------------------------------------------------------

const EVENT_META = { http: { method: 'POST', path: '/orders' } };
const RPC_META = { http: { method: 'GET', path: '/orders/:id' }, auth: 'bearer' };
const BROADCAST_META = { scope: 'global' };

/** Short TTL for tests — entries expire quickly after heartbeat stops. */
const TEST_TTL = 3_000;

// ---------------------------------------------------------------------------
// Test Controllers
// ---------------------------------------------------------------------------

@Controller()
class MetaController {
  @EventPattern('order.created', { meta: EVENT_META })
  handleOrderCreated(@Payload() _data: unknown): void {}

  @MessagePattern('order.get', { meta: RPC_META })
  handleGetOrder(@Payload() _data: unknown): string {
    return 'ok';
  }

  @EventPattern('config.updated', { broadcast: true, meta: BROADCAST_META })
  handleConfigUpdated(@Payload() _data: unknown): void {}

  @EventPattern('internal.cleanup')
  handleCleanup(@Payload() _data: unknown): void {}
}

@Controller()
class NoMetaController {
  @EventPattern('order.shipped')
  handleShipped(@Payload() _data: unknown): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** KV bucket underlying stream name follows NATS convention: KV_{bucket}. */
const KV_STREAM_NAME = `KV_${DEFAULT_METADATA_BUCKET}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Handler Metadata Registry', { timeout: 60_000 }, () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);
  });

  afterAll(async () => {
    try {
      await nc.drain();
    } finally {
      await container.stop();
    }
  });

  const openKv = async (): Promise<KV> => {
    const js = jetstream(nc);
    const kvm = new Kvm(js);

    return kvm.open(DEFAULT_METADATA_BUCKET);
  };

  const destroyBucketIfExists = async (): Promise<void> => {
    const jsm = await jetstreamManager(nc);

    try {
      await jsm.streams.delete(KV_STREAM_NAME);
    } catch {
      /* stream doesn't exist — nothing to destroy */
    }
  };

  describe('metadata publishing', () => {
    let app: INestApplication | undefined;
    let serviceName: string | undefined;

    afterEach(async () => {
      if (app) await app.close();
      if (serviceName) await cleanupStreams(nc, serviceName);
      await destroyBucketIfExists();
    });

    it('should write handler meta entries to KV bucket', async () => {
      // Given: a service with handlers that have meta
      serviceName = uniqueServiceName();
      ({ app } = await createTestApp(
        { name: serviceName, port, metadata: { ttl: TEST_TTL } },
        [MetaController],
        [serviceName],
      ));

      // When: we read the KV bucket
      const kv = await openKv();

      // Then: event handler meta exists at the correct key
      const eventEntry = await kv.get(metadataKey(serviceName, StreamKind.Event, 'order.created'));

      expect(eventEntry).not.toBeNull();
      expect(eventEntry!.json()).toEqual(EVENT_META);

      // Then: RPC handler meta exists at the correct key
      const rpcEntry = await kv.get(metadataKey(serviceName, StreamKind.Command, 'order.get'));

      expect(rpcEntry).not.toBeNull();
      expect(rpcEntry!.json()).toEqual(RPC_META);

      // Then: broadcast handler meta exists at the correct key
      const broadcastEntry = await kv.get(
        metadataKey(serviceName, StreamKind.Broadcast, 'config.updated'),
      );

      expect(broadcastEntry).not.toBeNull();
      expect(broadcastEntry!.json()).toEqual(BROADCAST_META);

      // Then: handler without meta is NOT in KV
      const noMetaEntry = await kv.get(
        metadataKey(serviceName, StreamKind.Event, 'internal.cleanup'),
      );

      expect(noMetaEntry).toBeNull();
    });

    it('should not create KV bucket when no handler has meta', async () => {
      // Given: destroy any existing bucket from prior tests
      await destroyBucketIfExists();

      // When: create app with controller that has no meta
      serviceName = uniqueServiceName();
      ({ app } = await createTestApp(
        { name: serviceName, port },
        [NoMetaController],
        [serviceName],
      ));

      // Then: the underlying KV stream should not exist
      const jsm = await jetstreamManager(nc);

      await expect(jsm.streams.info(KV_STREAM_NAME)).rejects.toThrow();
    });

    it('should be idempotent — same service writes same keys', async () => {
      // Given: first app writes metadata
      serviceName = uniqueServiceName();
      const { app: firstApp } = await createTestApp(
        { name: serviceName, port, metadata: { ttl: TEST_TTL } },
        [MetaController],
        [serviceName],
      );

      const kv = await openKv();
      const eventKey = metadataKey(serviceName, StreamKind.Event, 'order.created');
      const firstEntry = await kv.get(eventKey);

      expect(firstEntry).not.toBeNull();

      const firstRevision = firstEntry!.revision;
      const firstValue = firstEntry!.json();

      // When: close first app and start second with same serviceName
      await firstApp.close();
      await cleanupStreams(nc, serviceName);

      const { app: secondApp } = await createTestApp(
        { name: serviceName, port, metadata: { ttl: TEST_TTL } },
        [MetaController],
        [serviceName],
      );

      app = secondApp;

      // Then: second app's revision is higher (new write) but value is identical
      const secondEntry = await kv.get(eventKey);

      expect(secondEntry).not.toBeNull();
      expect(secondEntry!.revision).toBeGreaterThan(firstRevision);
      expect(secondEntry!.json()).toEqual(firstValue);
    });
  });

  describe('TTL lifecycle', () => {
    let app: INestApplication | undefined;
    let serviceName: string | undefined;

    afterEach(async () => {
      if (app) {
        try {
          await app.close();
        } catch {
          /* already closed */
        }
      }

      if (serviceName) await cleanupStreams(nc, serviceName);
      await destroyBucketIfExists();
    });

    it('should expire entries after shutdown when heartbeat stops', async () => {
      // Given: app with short TTL (3s)
      serviceName = uniqueServiceName();
      ({ app } = await createTestApp(
        { name: serviceName, port, metadata: { ttl: TEST_TTL } },
        [MetaController],
        [serviceName],
      ));

      const kv = await openKv();
      const eventKey = metadataKey(serviceName, StreamKind.Event, 'order.created');

      // Verify entry exists
      const entryBefore = await kv.get(eventKey);

      expect(entryBefore).not.toBeNull();

      // When: graceful shutdown (heartbeat stops)
      await app.close();
      app = undefined;

      // Then: entry expires after TTL
      await waitForCondition(
        async () => {
          const entry = await kv.get(eventKey);

          return entry === null;
        },
        TEST_TTL + 2_000,
        500,
      );
    });

    it('should keep entries alive while app is running via heartbeat', async () => {
      // Given: app with short TTL (3s), heartbeat refreshes every 1.5s
      serviceName = uniqueServiceName();
      ({ app } = await createTestApp(
        { name: serviceName, port, metadata: { ttl: TEST_TTL } },
        [MetaController],
        [serviceName],
      ));

      const kv = await openKv();
      const eventKey = metadataKey(serviceName, StreamKind.Event, 'order.created');

      // When: wait longer than TTL (heartbeat should keep entries alive)
      await new Promise((r) => setTimeout(r, TEST_TTL + 1_000));

      // Then: entry still exists (heartbeat refreshed it)
      const entry = await kv.get(eventKey);

      expect(entry).not.toBeNull();
      expect(entry!.json()).toEqual(EVENT_META);
    });
  });
});
