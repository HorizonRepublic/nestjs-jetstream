import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { DeliverPolicy, NatsConnection } from 'nats';
import { firstValueFrom } from 'rxjs';

import { getClientToken } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';

// ---------------------------------------------------------------------------
// Test Controllers
// ---------------------------------------------------------------------------

@Controller()
class OrderedController {
  public readonly received: unknown[] = [];

  @EventPattern('order.status', { ordered: true })
  handleOrderStatus(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

@Controller()
class MixedController {
  public readonly orderedReceived: unknown[] = [];
  public readonly workqueueReceived: unknown[] = [];

  @EventPattern('order.status', { ordered: true })
  handleOrdered(@Payload() data: unknown): void {
    this.orderedReceived.push(data);
  }

  @EventPattern('order.created')
  handleWorkqueue(@Payload() data: unknown): void {
    this.workqueueReceived.push(data);
  }
}

@Controller()
class FailingOrderedController {
  public callCount = 0;

  @EventPattern('order.fail', { ordered: true })
  handleOrder(): void {
    this.callCount++;
    throw new Error('Ordered handler failure');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Ordered Event Delivery', () => {
  let nc: NatsConnection;

  beforeAll(async () => {
    nc = await createNatsConnection();
  });

  afterAll(async () => {
    await nc.drain();
  });

  describe('basic ordered delivery', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: OrderedController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName },
        [OrderedController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(OrderedController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should deliver ordered events to handler', async () => {
      await firstValueFrom(client.emit('ordered:order.status', { status: 'created' }));

      await waitForCondition(() => controller.received.length > 0, 5_000);

      expect(controller.received[0]).toEqual({ status: 'created' });
    });

    it('should deliver multiple events in strict order', async () => {
      const statuses = ['created', 'paid', 'shipped', 'delivered'];

      for (const status of statuses) {
        await firstValueFrom(client.emit('ordered:order.status', { status }));
      }

      await waitForCondition(() => controller.received.length === 4, 10_000);

      expect(controller.received).toEqual(statuses.map((status) => ({ status })));
    });
  });

  describe('mixed ordered and workqueue handlers', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: MixedController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName },
        [MixedController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(MixedController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should deliver ordered and workqueue events independently', async () => {
      await firstValueFrom(client.emit('ordered:order.status', { status: 'paid' }));
      await firstValueFrom(client.emit('order.created', { orderId: 1 }));

      await waitForCondition(
        () => controller.orderedReceived.length > 0 && controller.workqueueReceived.length > 0,
        5_000,
      );

      expect(controller.orderedReceived[0]).toEqual({ status: 'paid' });
      expect(controller.workqueueReceived[0]).toEqual({ orderId: 1 });
    });
  });

  describe('DeliverPolicy.All (explicit)', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: OrderedController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName, ordered: { deliverPolicy: DeliverPolicy.All } },
        [OrderedController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(OrderedController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should deliver all messages from the beginning (workaround for nats.js bug)', async () => {
      await firstValueFrom(client.emit('ordered:order.status', { status: 'replayed' }));

      await waitForCondition(() => controller.received.length > 0, 5_000);

      expect(controller.received[0]).toEqual({ status: 'replayed' });
    });
  });

  describe('DeliverPolicy.New', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: OrderedController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName, ordered: { deliverPolicy: DeliverPolicy.New } },
        [OrderedController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(OrderedController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should only deliver messages published after consumer started', async () => {
      // Given: consumer already running with DeliverPolicy.New
      // (no delay needed — startOrdered awaits consumer readiness)

      // When: publish after consumer started
      await firstValueFrom(client.emit('ordered:order.status', { status: 'new-only' }));

      await waitForCondition(() => controller.received.length > 0, 5_000);

      // Then: message delivered
      expect(controller.received[0]).toEqual({ status: 'new-only' });
    });
  });

  describe('DeliverPolicy.Last', () => {
    it('should deliver only the last message in the stream', async () => {
      const serviceName = uniqueServiceName();

      // Step 1: start app with default policy to create stream and publish messages
      let { app, module } = await createTestApp(
        { name: serviceName },
        [OrderedController],
        [serviceName],
      );

      const client = module.get<ClientProxy>(getClientToken(serviceName));

      await firstValueFrom(client.emit('ordered:order.status', { status: 'first' }));
      await firstValueFrom(client.emit('ordered:order.status', { status: 'second' }));
      await firstValueFrom(client.emit('ordered:order.status', { status: 'third' }));
      await app.close();

      // Step 2: restart with DeliverPolicy.Last — should get only the last message
      ({ app, module } = await createTestApp(
        { name: serviceName, ordered: { deliverPolicy: DeliverPolicy.Last } },
        [OrderedController],
        [serviceName],
      ));

      const controller = module.get(OrderedController);

      await waitForCondition(() => controller.received.length > 0, 5_000);

      expect(controller.received[0]).toEqual({ status: 'third' });

      await app.close();
      await cleanupStreams(nc, serviceName);
    }, 15_000);
  });

  describe('DeliverPolicy.LastPerSubject', () => {
    it('should deliver the last message per subject', async () => {
      const serviceName = uniqueServiceName();

      // Step 1: publish messages with default policy
      let { app, module } = await createTestApp(
        { name: serviceName },
        [OrderedController],
        [serviceName],
      );

      const client = module.get<ClientProxy>(getClientToken(serviceName));

      await firstValueFrom(client.emit('ordered:order.status', { status: 'old' }));
      await firstValueFrom(client.emit('ordered:order.status', { status: 'latest' }));
      await app.close();

      // Step 2: restart with DeliverPolicy.LastPerSubject
      ({ app, module } = await createTestApp(
        { name: serviceName, ordered: { deliverPolicy: DeliverPolicy.LastPerSubject } },
        [OrderedController],
        [serviceName],
      ));

      const controller = module.get(OrderedController);

      await waitForCondition(() => controller.received.length > 0, 5_000);

      expect(controller.received[0]).toEqual({ status: 'latest' });

      await app.close();
      await cleanupStreams(nc, serviceName);
    }, 15_000);
  });

  describe('DeliverPolicy.StartSequence', () => {
    it('should deliver from specified sequence number', async () => {
      const serviceName = uniqueServiceName();

      // Step 1: publish 3 messages
      let { app, module } = await createTestApp(
        { name: serviceName },
        [OrderedController],
        [serviceName],
      );

      const client = module.get<ClientProxy>(getClientToken(serviceName));

      await firstValueFrom(client.emit('ordered:order.status', { seq: 1 }));
      await firstValueFrom(client.emit('ordered:order.status', { seq: 2 }));
      await firstValueFrom(client.emit('ordered:order.status', { seq: 3 }));
      await app.close();

      // Step 2: restart with StartSequence from seq 2
      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          ordered: { deliverPolicy: DeliverPolicy.StartSequence, optStartSeq: 2 },
        },
        [OrderedController],
        [serviceName],
      ));

      const controller = module.get(OrderedController);

      await waitForCondition(() => controller.received.length >= 2, 5_000);

      expect(controller.received).toEqual([{ seq: 2 }, { seq: 3 }]);

      await app.close();
      await cleanupStreams(nc, serviceName);
    }, 15_000);
  });

  describe('DeliverPolicy.StartTime', () => {
    it('should deliver messages from specified start time', async () => {
      const serviceName = uniqueServiceName();

      // Step 1: publish a message, record time, publish another
      let { app, module } = await createTestApp(
        { name: serviceName },
        [OrderedController],
        [serviceName],
      );

      const client = module.get<ClientProxy>(getClientToken(serviceName));

      await firstValueFrom(client.emit('ordered:order.status', { status: 'before' }));

      // Ensure NATS timestamps differ — sub-millisecond publishes can share the same timestamp
      await new Promise((r) => setTimeout(r, 50));
      const startTime = new Date().toISOString();

      await firstValueFrom(client.emit('ordered:order.status', { status: 'after' }));
      await app.close();

      // Step 2: restart with StartTime — should skip 'before', get 'after'
      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          ordered: { deliverPolicy: DeliverPolicy.StartTime, optStartTime: startTime },
        },
        [OrderedController],
        [serviceName],
      ));

      const controller = module.get(OrderedController);

      await waitForCondition(() => controller.received.length > 0, 5_000);

      expect(controller.received[0]).toEqual({ status: 'after' });

      await app.close();
      await cleanupStreams(nc, serviceName);
    }, 15_000);
  });

  describe('ordered handler error', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: FailingOrderedController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName },
        [FailingOrderedController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(FailingOrderedController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should not redeliver on error (ordered consumers have no retry)', async () => {
      await firstValueFrom(client.emit('ordered:order.fail', { orderId: 1 }));

      await waitForCondition(() => controller.callCount > 0, 5_000);

      // Wait a bit to ensure no redelivery
      await new Promise((r) => setTimeout(r, 2_000));

      // Ordered consumer: handler called once, no retry
      expect(controller.callCount).toBe(1);
    });
  });
});
