import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { NatsConnection } from 'nats';
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

  beforeAll(async () => {
    nc = await createNatsConnection();
  });

  afterAll(async () => {
    await nc.drain();
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
        { name: serviceName },
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

    it('should deliver event to handler and ack', async () => {
      await firstValueFrom(client.emit('order.created', { orderId: 123 }));

      await waitForCondition(() => controller.received.length > 0, 5_000);

      expect(controller.received[0]).toEqual({ orderId: 123 });
    });

    it('should deliver multiple events in order', async () => {
      for (let i = 0; i < 5; i++) {
        await firstValueFrom(client.emit('order.created', { orderId: i }));
      }

      await waitForCondition(() => controller.received.length === 5, 10_000);

      expect(controller.received).toEqual(
        [0, 1, 2, 3, 4].map((i) => ({ orderId: i })),
      );
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
        { name: serviceName },
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

      // Wait for the successful delivery (second attempt)
      await waitForCondition(() => controller.received.length > 0, 10_000);

      expect(controller.attempts).toBeGreaterThanOrEqual(2);
      expect(controller.received[0]).toEqual({ orderId: 42 });
    });
  });
});
