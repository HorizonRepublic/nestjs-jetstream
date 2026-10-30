import { Controller, INestApplication } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';

import {
  AckPolicy,
  DeliverPolicy,
  jetstreamManager,
  type JetStreamManager,
  RetentionPolicy,
  StorageType,
} from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { JetstreamHealthIndicator, ManagementMode } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  deleteStreamIfExists,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

/** Past the indicator's 30-second stall threshold. */
const PAST_STALL_THRESHOLD_MS = 31_000;

@Controller()
class OrdersController {
  @EventPattern('order.created')
  handle(@Payload() _data: unknown): void {}
}

describe('Health: consumer flows', () => {
  let container: StartedTestContainer;
  let port: number;
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  let app: INestApplication;
  let module: TestingModule;
  let serviceName: string;
  let stream: string;
  let consumer: string;
  let subject: string;

  const addConsumer = async (): Promise<void> => {
    await jsm.consumers.add(stream, {
      durable_name: consumer,
      ack_policy: AckPolicy.Explicit,
      filter_subject: subject,
      deliver_policy: DeliverPolicy.All,
    });
  };

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);
    jsm = await jetstreamManager(nc);
  });

  afterAll(async () => {
    try {
      await nc.drain();
    } finally {
      await container.stop();
    }
  });

  beforeEach(async () => {
    serviceName = uniqueServiceName();
    stream = `ext_health_${serviceName}`;
    consumer = `ext_health_worker_${serviceName}`;
    const prefix = `ext.health.${serviceName}.`;

    subject = `${prefix}order.created`;

    await jsm.streams.add({
      name: stream,
      subjects: [`${prefix}>`],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
    });
    await addConsumer();

    ({ app, module } = await createTestApp(
      {
        name: serviceName,
        port,
        provisioning: { management: ManagementMode.Manual },
        events: {
          stream: { name: stream },
          consumer: { durable_name: consumer },
          subjectPrefix: prefix,
          // Detect the deleted consumer within a couple of seconds
          consume: { idle_heartbeat: 1_000 },
        },
      },
      [OrdersController],
    ));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close().catch(() => {});
    await cleanupStreams(nc, serviceName).catch(() => {});
    await deleteStreamIfExists(jsm, stream);
  });

  it(
    'should degrade on a missing external consumer and fail only the opt-in check',
    { timeout: 60_000 },
    async () => {
      // Given: a service consuming from an externally managed consumer
      const sut = module.get(JetstreamHealthIndicator);

      await waitForCondition(
        async () => (await sut.check()).consumers?.event?.state === 'active',
        10_000,
      );
      await expect(sut.isHealthy()).resolves.toEqual({
        jetstream: expect.objectContaining({
          status: 'up',
          consuming: true,
          consumers: { event: expect.objectContaining({ state: 'active', consumer }) },
        }),
      });

      // When: the consumer disappears and self-healing cannot rebind
      await jsm.consumers.delete(stream, consumer);

      let failing = await sut.check();

      await waitForCondition(async () => {
        failing = await sut.check();

        return (failing.consumers?.event?.failures ?? 0) > 0;
      }, 20_000);

      // Then: still ready inside the threshold, so a brief outage does not flap
      expect(failing.connected).toBe(true);
      expect(failing.consuming).toBe(true);
      expect(failing.consumers?.event).toEqual(
        expect.objectContaining({
          healthy: true,
          state: 'recovering',
          lastError: expect.stringContaining(consumer),
        }),
      );

      // When: the outage outlasts the threshold
      const now = Date.now();

      vi.spyOn(Date, 'now').mockReturnValue(now + PAST_STALL_THRESHOLD_MS);

      // Then: the default check degrades, the opt-in readiness check fails
      const stalled = await sut.check();

      expect(stalled.connected).toBe(true);
      expect(stalled.consuming).toBe(false);
      expect(stalled.degraded).toBe(true);
      expect(stalled.consumers?.event?.healthy).toBe(false);
      await expect(sut.isHealthy()).resolves.toEqual({
        jetstream: expect.objectContaining({ status: 'up', consuming: false, degraded: true }),
      });
      await expect(sut.isHealthy('jetstream', { requireConsumers: true })).rejects.toMatchObject({
        causes: { jetstream: { status: 'down', consuming: false } },
      });

      vi.restoreAllMocks();

      // When: the consumer is restored out of band
      await addConsumer();

      // Then: the flow rebinds and readiness comes back
      await waitForCondition(
        async () => (await sut.check()).consumers?.event?.state === 'active',
        20_000,
      );
      await expect(sut.isHealthy('jetstream', { requireConsumers: true })).resolves.toEqual({
        jetstream: expect.objectContaining({ status: 'up', consuming: true, degraded: false }),
      });
    },
  );
});
