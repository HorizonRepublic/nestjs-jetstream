import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, Ctx, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { NatsConnection } from 'nats';
import { firstValueFrom } from 'rxjs';

import { getClientToken, RpcContext, toNanos } from '../../src';

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
class RetryController {
  public attempts = 0;
  public readonly received: unknown[] = [];

  @EventPattern('order.retry')
  handle(@Payload() data: unknown, @Ctx() ctx: RpcContext): void {
    this.attempts++;

    if (this.attempts === 1) {
      ctx.retry();
      return;
    }

    this.received.push(data);
  }
}

@Controller()
class DelayedRetryController {
  public attempts = 0;
  public attemptTimestamps: number[] = [];
  public readonly received: unknown[] = [];

  @EventPattern('order.delayed-retry')
  handle(@Payload() data: unknown, @Ctx() ctx: RpcContext): void {
    this.attempts++;
    this.attemptTimestamps.push(Date.now());

    if (this.attempts === 1) {
      ctx.retry({ delayMs: 1_000 });
      return;
    }

    this.received.push(data);
  }
}

@Controller()
class TerminateController {
  public attempts = 0;

  @EventPattern('order.terminate')
  handle(@Payload() _data: unknown, @Ctx() ctx: RpcContext): void {
    this.attempts++;
    ctx.terminate('Business reason');
  }
}

@Controller()
class MetadataController {
  public deliveryCount: number | undefined;
  public stream: string | undefined;
  public sequence: number | undefined;
  public timestamp: Date | undefined;
  public callerName: string | undefined;

  @EventPattern('order.metadata')
  handle(@Payload() _data: unknown, @Ctx() ctx: RpcContext): void {
    this.deliveryCount = ctx.getDeliveryCount();
    this.stream = ctx.getStream();
    this.sequence = ctx.getSequence();
    this.timestamp = ctx.getTimestamp();
    this.callerName = ctx.getCallerName();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Handler Context', () => {
  let nc: NatsConnection;

  beforeAll(async () => {
    nc = await createNatsConnection();
  });

  afterAll(async () => {
    await nc.drain();
  });

  describe('ctx.retry()', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: RetryController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          events: {
            consumer: { ack_wait: toNanos(2, 'seconds'), max_deliver: 5 },
          },
        },
        [RetryController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(RetryController);
    });

    afterEach(async () => {
      await app?.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should redeliver message after ctx.retry()', async () => {
      // When: emit an event
      await firstValueFrom(client.emit('order.retry', { id: 1 }));

      // Then: handler called twice — retry on first, success on second
      await waitForCondition(() => controller.received.length === 1, 10_000);

      expect(controller.attempts).toBe(2);
      expect(controller.received).toHaveLength(1);
    });
  });

  describe('ctx.retry({ delayMs })', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: DelayedRetryController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          events: {
            consumer: { ack_wait: toNanos(5, 'seconds'), max_deliver: 5 },
          },
        },
        [DelayedRetryController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(DelayedRetryController);
    });

    afterEach(async () => {
      await app?.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should redeliver message after the specified delay', async () => {
      // When: emit an event
      await firstValueFrom(client.emit('order.delayed-retry', { id: 2 }));

      // Then: handler called twice with delay between attempts
      await waitForCondition(() => controller.received.length === 1, 15_000);

      expect(controller.attempts).toBe(2);

      const [first, second] = controller.attemptTimestamps;
      const gap = second! - first!;

      // Delay should be at least ~1000ms (allow some slack for scheduling)
      expect(gap).toBeGreaterThanOrEqual(900);
    });
  });

  describe('ctx.terminate()', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: TerminateController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          events: {
            consumer: { ack_wait: toNanos(2, 'seconds'), max_deliver: 5 },
          },
        },
        [TerminateController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(TerminateController);
    });

    afterEach(async () => {
      await app?.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should not redeliver message after ctx.terminate()', async () => {
      // When: emit an event
      await firstValueFrom(client.emit('order.terminate', { id: 3 }));

      // Then: handler called exactly once — terminated, no redelivery
      await waitForCondition(() => controller.attempts === 1, 5_000);

      // Wait extra time to confirm no redelivery
      await new Promise((r) => setTimeout(r, 3_000));

      expect(controller.attempts).toBe(1);
    });
  });

  describe('metadata getters', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: MetadataController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName },
        [MetadataController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(MetadataController);
    });

    afterEach(async () => {
      await app?.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should populate all JetStream metadata from context', async () => {
      // When: emit an event
      await firstValueFrom(client.emit('order.metadata', { id: 4 }));

      // Then: all metadata fields are populated
      await waitForCondition(() => controller.deliveryCount !== undefined, 5_000);

      expect(controller.deliveryCount).toBe(1);
      expect(controller.stream).toContain('ev-stream');
      expect(controller.sequence).toBeGreaterThan(0);
      expect(controller.timestamp).toBeInstanceOf(Date);
      expect(controller.callerName).toContain('__microservice');
    });
  });
});
