import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import type { NatsConnection } from '@nats-io/transport-node';
import { DeliverPolicy } from '@nats-io/jetstream';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { getClientToken } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

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

@Controller()
class MultiPatternOrderedController {
  public readonly statusReceived: unknown[] = [];
  public readonly auditReceived: unknown[] = [];

  @EventPattern('order.status', { ordered: true })
  handleStatus(@Payload() data: unknown): void {
    this.statusReceived.push(data);
  }

  @EventPattern('order.audit', { ordered: true })
  handleAudit(@Payload() data: unknown): void {
    this.auditReceived.push(data);
  }
}

@Controller()
class OrderedWithDlqController {
  public readonly orderedReceived: unknown[] = [];
  public workqueueAttempts = 0;

  @EventPattern('order.status', { ordered: true })
  handleOrdered(@Payload() data: unknown): void {
    this.orderedReceived.push(data);
    throw new Error('Ordered handler fails');
  }

  @EventPattern('order.process')
  handleWorkqueue(): void {
    this.workqueueAttempts++;
    throw new Error('Workqueue handler fails');
  }
}

describe('Ordered Event Delivery', () => {
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

  describe('basic ordered delivery', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: OrderedController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName, port },
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
        { name: serviceName, port },
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
        { name: serviceName, port, ordered: { deliverPolicy: DeliverPolicy.All } },
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
        { name: serviceName, port, ordered: { deliverPolicy: DeliverPolicy.New } },
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
        { name: serviceName, port },
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
        { name: serviceName, port, ordered: { deliverPolicy: DeliverPolicy.Last } },
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
    it('should deliver the last message per subject across multiple patterns', async () => {
      const serviceName = uniqueServiceName();

      // Step 1: publish to two different ordered subjects
      let { app, module } = await createTestApp(
        { name: serviceName, port },
        [MultiPatternOrderedController],
        [serviceName],
      );

      const client = module.get<ClientProxy>(getClientToken(serviceName));

      await firstValueFrom(client.emit('ordered:order.status', { status: 'old' }));
      await firstValueFrom(client.emit('ordered:order.status', { status: 'latest-status' }));
      await firstValueFrom(client.emit('ordered:order.audit', { action: 'old-action' }));
      await firstValueFrom(client.emit('ordered:order.audit', { action: 'latest-audit' }));
      await app.close();

      // Step 2: restart with DeliverPolicy.LastPerSubject
      ({ app, module } = await createTestApp(
        { name: serviceName, port, ordered: { deliverPolicy: DeliverPolicy.LastPerSubject } },
        [MultiPatternOrderedController],
        [serviceName],
      ));

      const controller = module.get(MultiPatternOrderedController);

      await waitForCondition(
        () => controller.statusReceived.length > 0 && controller.auditReceived.length > 0,
        5_000,
      );

      // Then: last message per subject — not all messages
      expect(controller.statusReceived).toEqual([{ status: 'latest-status' }]);
      expect(controller.auditReceived).toEqual([{ action: 'latest-audit' }]);

      await app.close();
      await cleanupStreams(nc, serviceName);
    }, 15_000);
  });

  describe('DeliverPolicy.StartSequence', () => {
    it('should deliver from specified sequence number', async () => {
      const serviceName = uniqueServiceName();

      // Step 1: publish 3 messages
      let { app, module } = await createTestApp(
        { name: serviceName, port },
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
          port,
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
        { name: serviceName, port },
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
          port,
          ordered: { deliverPolicy: DeliverPolicy.StartTime, optStartTime: startTime },
        },
        [OrderedController],
        [serviceName],
      ));

      const controller = module.get(OrderedController);

      await waitForCondition(() => controller.received.length > 0, 10_000);

      expect(controller.received[0]).toEqual({ status: 'after' });

      await app.close();
      await cleanupStreams(nc, serviceName);
    }, 20_000);
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
        { name: serviceName, port },
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

  describe('multiple ordered patterns', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: MultiPatternOrderedController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName, port },
        [MultiPatternOrderedController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(MultiPatternOrderedController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should route messages to correct ordered handlers by pattern', async () => {
      await firstValueFrom(client.emit('ordered:order.status', { status: 'shipped' }));
      await firstValueFrom(client.emit('ordered:order.audit', { action: 'viewed' }));

      await waitForCondition(
        () => controller.statusReceived.length > 0 && controller.auditReceived.length > 0,
        5_000,
      );

      expect(controller.statusReceived[0]).toEqual({ status: 'shipped' });
      expect(controller.auditReceived[0]).toEqual({ action: 'viewed' });
    });
  });

  describe('ordered + DLQ independence', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: OrderedWithDlqController;
    let deadLetters: unknown[];

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      deadLetters = [];

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          onDeadLetter: async (info) => {
            deadLetters.push(info);
          },
        },
        [OrderedWithDlqController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(OrderedWithDlqController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should not trigger DLQ for ordered handler failures', async () => {
      // Given: ordered handler that always throws
      await firstValueFrom(client.emit('ordered:order.status', { status: 'fail' }));

      await waitForCondition(() => controller.orderedReceived.length > 0, 5_000);

      // Wait to confirm no DLQ triggered
      await new Promise((r) => setTimeout(r, 1_000));

      // Then: ordered handler was called, but no dead letters
      expect(controller.orderedReceived.length).toBeGreaterThan(0);
      expect(deadLetters).toHaveLength(0);
    });

    it('should still trigger DLQ for workqueue handler failures', async () => {
      // Given: workqueue handler that always throws (max_deliver: 3)
      await firstValueFrom(client.emit('order.process', { orderId: 1 }));

      // Wait for all redeliveries + DLQ (ack_wait 10s × 3 attempts)
      await waitForCondition(() => deadLetters.length > 0, 35_000);

      // Then: DLQ triggered for workqueue, not for ordered
      expect(deadLetters.length).toBeGreaterThan(0);
      expect(controller.workqueueAttempts).toBeGreaterThanOrEqual(3);
    }, 40_000);
  });

  describe('publisher-only mode with ordered events', () => {
    it('should publish ordered events without consumer infrastructure', async () => {
      const serviceName = uniqueServiceName();

      // Step 1: start a consumer service to create the stream and listen
      const { app: consumerApp, module: consumerModule } = await createTestApp(
        { name: serviceName, port },
        [OrderedController],
        [serviceName],
      );

      const consumerCtrl = consumerModule.get(OrderedController);

      // Step 2: start a publisher-only service
      const { app: publisherApp, module: publisherModule } = await createTestApp(
        { name: serviceName, port, consumer: false },
        [],
        [serviceName],
      );

      const publisherClient = publisherModule.get<ClientProxy>(getClientToken(serviceName));

      // When: publish from publisher-only service
      await firstValueFrom(
        publisherClient.emit('ordered:order.status', { status: 'from-publisher' }),
      );

      await waitForCondition(() => consumerCtrl.received.length > 0, 5_000);

      // Then: consumer service received the message
      expect(consumerCtrl.received[0]).toEqual({ status: 'from-publisher' });

      await publisherApp.close();
      await consumerApp.close();
      await cleanupStreams(nc, serviceName);
    });
  });
});
