import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { NatsConnection } from 'nats';
import { firstValueFrom } from 'rxjs';

import type { DeadLetterInfo } from '../../src';
import { getClientToken, nanos } from '../../src';

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
class AlwaysFailingController {
  public attempts = 0;

  @EventPattern('order.doomed')
  handleOrder(@Payload() _data: unknown): never {
    this.attempts++;
    throw new Error('Permanent failure');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dead Letter Queue Hook', () => {
  let nc: NatsConnection;

  beforeAll(async () => {
    nc = await createNatsConnection();
  });

  afterAll(async () => {
    await nc.drain();
  });

  describe('onDeadLetter callback', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: AlwaysFailingController;

    const deadLetters: DeadLetterInfo[] = [];

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      deadLetters.length = 0;

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          events: {
            consumer: {
              max_deliver: 2,

              ack_wait: nanos(2_000),
            },
          },
          onDeadLetter: async (info) => {
            deadLetters.push(info);
          },
        },
        [AlwaysFailingController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(AlwaysFailingController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should invoke onDeadLetter after all delivery attempts are exhausted', async () => {
      // Given: emit an event that will always fail
      await firstValueFrom(client.emit('order.doomed', { orderId: 'abc-123' }));

      // When: wait for max_deliver attempts (2) + ack_wait (2s) + processing
      await waitForCondition(() => deadLetters.length > 0, 10_000);

      // Then: dead letter callback received with correct info
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]).toMatchObject({
        subject: expect.stringContaining('order.doomed'),
        data: { orderId: 'abc-123' },
        // NestJS exception filter wraps errors into { status, message }
        error: expect.objectContaining({ status: 'error' }),
        deliveryCount: 2,
      });
      expect(deadLetters[0]!.stream).toBeDefined();
      expect(deadLetters[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Handler was attempted exactly max_deliver times
      expect(controller.attempts).toBe(2);
    });
  });

  describe('without onDeadLetter configured', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: AlwaysFailingController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          events: {
            consumer: {
              max_deliver: 2,

              ack_wait: nanos(2_000),
            },
          },
        },
        [AlwaysFailingController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(AlwaysFailingController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should gracefully handle exhausted deliveries without crash', async () => {
      // Given: emit an event with no DLQ hook
      await firstValueFrom(client.emit('order.doomed', { orderId: 'no-dlq' }));

      // When: wait for all deliveries to be exhausted
      await waitForCondition(() => controller.attempts >= 2, 10_000);

      // Then: no crash, handler was attempted max_deliver times
      expect(controller.attempts).toBe(2);
    });
  });
});
