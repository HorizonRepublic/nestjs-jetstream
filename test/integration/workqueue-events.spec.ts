import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { NatsConnection } from 'nats';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { getClientToken, JetstreamRecordBuilder } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

// ---------------------------------------------------------------------------
// Test Controllers
// ---------------------------------------------------------------------------

@Controller()
class EventController {
  public readonly received: unknown[] = [];

  @EventPattern('order.created')
  handleOrder(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

@Controller()
class FailingEventController {
  public attempts = 0;
  public readonly received: unknown[] = [];

  @EventPattern('order.retry')
  handleOrder(@Payload() data: unknown): void {
    this.attempts++;

    if (this.attempts === 1) {
      throw new Error('Transient failure');
    }

    this.received.push(data);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Workqueue Event Delivery', () => {
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

  describe('happy path', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: EventController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName, port },
        [EventController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(EventController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should deliver event to handler', async () => {
      await firstValueFrom(client.emit('order.created', { orderId: 123 }));

      await waitForCondition(() => controller.received.length > 0, 5_000);

      expect(controller.received[0]).toEqual({ orderId: 123 });
    });

    it('should deliver multiple events in order', async () => {
      for (let i = 0; i < 5; i++) {
        await firstValueFrom(client.emit('order.created', { orderId: i }));
      }

      await waitForCondition(() => controller.received.length === 5, 10_000);

      expect(controller.received).toEqual([0, 1, 2, 3, 4].map((i) => ({ orderId: i })));
    });
  });

  describe('custom messageId deduplication', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: EventController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName, port },
        [EventController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(EventController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should deduplicate events with the same messageId', async () => {
      // Given: two events with the same messageId
      const messageId = `order-dedup-${Date.now()}`;
      const record = new JetstreamRecordBuilder({ orderId: 1 }).setMessageId(messageId).build();

      // When: publish the same messageId twice
      await firstValueFrom(client.emit('order.created', record));
      await firstValueFrom(client.emit('order.created', record));

      // Then: wait and verify only one delivery (NATS deduplicates)
      await waitForCondition(() => controller.received.length > 0, 5_000);
      // Allow extra time for any duplicate to arrive before asserting deduplication
      await new Promise((r) => setTimeout(r, 2_000));

      expect(controller.received).toHaveLength(1);
      expect(controller.received[0]).toEqual({ orderId: 1 });
    });
  });

  describe('retry on error (nak)', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: FailingEventController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName, port },
        [FailingEventController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(FailingEventController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should redeliver on handler error (nak) and succeed on retry', async () => {
      await firstValueFrom(client.emit('order.retry', { orderId: 42 }));

      // Wait for the successful delivery (second attempt).
      // Timeout must exceed ack_wait (10s default) to allow redelivery.
      await waitForCondition(() => controller.received.length > 0, 15_000);

      expect(controller.attempts).toBeGreaterThanOrEqual(2);
      expect(controller.received[0]).toEqual({ orderId: 42 });
    });
  });
});
