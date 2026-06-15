import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, Ctx, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import type { NatsConnection } from '@nats-io/transport-node';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import type { DeadLetterInfo, RpcContext } from '../../src';
import {
  getClientToken,
  internalName,
  toNanos,
  dlqStreamName,
  JetstreamDlqHeader,
} from '../../src';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class AlwaysFailingController {
  public attempts = 0;

  @EventPattern('order.doomed')
  handleOrder(@Payload() _data: unknown): never {
    this.attempts++;
    throw new Error('Permanent failure');
  }
}

@Controller()
class AlwaysRetryingController {
  public attempts = 0;

  @EventPattern('order.postponed')
  handleOrder(@Payload() _data: unknown, @Ctx() ctx: RpcContext): void {
    this.attempts++;
    ctx.retry();
  }
}

describe('Dead Letter Queue Hook', () => {
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
          port,
          events: {
            consumer: {
              max_deliver: 2,

              ack_wait: toNanos(2, 'seconds'),
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
          port,
          events: {
            consumer: {
              max_deliver: 2,

              ack_wait: toNanos(2, 'seconds'),
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
  describe('ctx.retry() exhausting deliveries', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: AlwaysRetryingController;

    const deadLetters: DeadLetterInfo[] = [];

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      deadLetters.length = 0;

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          events: {
            consumer: {
              max_deliver: 2,
              ack_wait: toNanos(2, 'seconds'),
            },
          },
          onDeadLetter: async (info) => {
            deadLetters.push(info);
          },
        },
        [AlwaysRetryingController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(AlwaysRetryingController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should treat retry() on the final delivery as a dead letter', async () => {
      // Given: a handler that requests a business retry on every delivery
      await firstValueFrom(client.emit('order.postponed', { orderId: 'retry-1' }));

      // When: all delivery attempts are exhausted via ctx.retry()
      await waitForCondition(() => deadLetters.length > 0, 10_000);

      // Then: the dead letter is captured instead of stranding the message
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]).toMatchObject({
        subject: expect.stringContaining('order.postponed'),
        data: { orderId: 'retry-1' },
        deliveryCount: 2,
      });
      expect(controller.attempts).toBe(2);
    });
  });

  describe('with native DLQ configured and no onDeadLetter callback', () => {
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
          port,
          dlq: {},
          events: {
            consumer: {
              max_deliver: 2,
              ack_wait: toNanos(2, 'seconds'),
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

    it('should republish exhausted messages to the DLQ stream in dlq-only mode', async () => {
      // Given: emit an event that will always fail
      await firstValueFrom(client.emit('order.doomed', { orderId: 'dlq-only-1' }));

      // When: all delivery attempts are exhausted
      await waitForCondition(() => controller.attempts >= 2, 10_000);

      // Then: the dead letter lands in the DLQ stream without any callback configured
      const jsm = await jetstreamManager(nc);
      const dlqName = dlqStreamName(serviceName);

      await waitForCondition(async () => {
        const info = await jsm.streams.info(dlqName);

        return info.state.messages === 1;
      }, 10_000);

      const msg = await jsm.streams.getMessage(dlqName, { seq: 1 });
      const decoded = JSON.parse(new TextDecoder().decode(msg!.data));

      expect(decoded.orderId).toBe('dlq-only-1');
      expect(msg!.header.get(JetstreamDlqHeader.DeliveryCount)).toBe('2');
    });
  });

  describe('unroutable messages with DLQ configured', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          dlq: {},
        },
        [AlwaysFailingController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    const dlqMessageCount = async (): Promise<number> => {
      const jsm = await jetstreamManager(nc);
      const info = await jsm.streams.info(dlqStreamName(serviceName));

      return info.state.messages;
    };

    it('should capture events without a registered handler in the DLQ', async () => {
      // Given: an event pattern no controller handles
      await firstValueFrom(client.emit('order.unknown', { orderId: 'orphan-1' }));

      // Then: the message lands in the DLQ instead of being deleted
      await waitForCondition(async () => (await dlqMessageCount()) === 1, 10_000);

      const jsm = await jetstreamManager(nc);
      const msg = await jsm.streams.getMessage(dlqStreamName(serviceName), { seq: 1 });

      expect(msg!.header.get(JetstreamDlqHeader.DeadLetterReason)).toContain('No handler');

      const decoded = JSON.parse(new TextDecoder().decode(msg!.data));

      expect(decoded.orderId).toBe('orphan-1');
    });

    it('should capture undecodable payloads in the DLQ', async () => {
      // Given: raw bytes that are not valid JSON, published to a handled subject
      const js = jetstream(nc);
      const subject = `${internalName(serviceName)}.ev.order.doomed`;
      const garbage = new Uint8Array([0xff, 0xfe, 0x00, 0x7b]);

      await js.publish(subject, garbage);

      // Then: the message lands in the DLQ with the original bytes intact
      await waitForCondition(async () => (await dlqMessageCount()) === 1, 10_000);

      const jsm = await jetstreamManager(nc);
      const msg = await jsm.streams.getMessage(dlqStreamName(serviceName), { seq: 1 });

      expect(msg!.header.get(JetstreamDlqHeader.DeadLetterReason)).toContain('Decode error');
      expect(new Uint8Array(msg!.data)).toEqual(garbage);
    });
  });

  describe('with native DLQ configured', () => {
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
          port,
          dlq: {},
          events: {
            consumer: {
              max_deliver: 2,
              ack_wait: toNanos(2, 'seconds'),
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

    it('should republish to DLQ stream and invoke onDeadLetter fallback', async () => {
      // Given: emit an event that will always fail
      await firstValueFrom(client.emit('order.doomed', { orderId: 'dlq-123' }));

      // When: wait for max_deliver attempts
      await waitForCondition(() => deadLetters.length > 0, 10_000);

      // Then: message is in DLQ stream
      const jsm = await jetstreamManager(nc);
      const dlqName = dlqStreamName(serviceName);

      const streamInfo = await jsm.streams.info(dlqName);

      expect(streamInfo.state.messages).toBe(1);

      const msg = await jsm.streams.getMessage(dlqName, { seq: 1 });

      expect(msg).toBeDefined();

      const decodedStr = new TextDecoder().decode(msg!.data);
      const decodedDict = JSON.parse(decodedStr);

      expect(decodedDict.orderId).toBe('dlq-123');

      const hdrs = msg!.header;

      expect(hdrs).toBeDefined();
      expect(hdrs.get(JetstreamDlqHeader.DeadLetterReason)).toMatch(/Permanent failure|error/i);
      expect(hdrs.get(JetstreamDlqHeader.DeliveryCount)).toBe('2');
      expect(hdrs.get(JetstreamDlqHeader.OriginalStream)).toBeDefined();

      // Then: the onDeadLetter fallback was ALSO invoked
      expect(deadLetters).toHaveLength(1);

      expect(controller.attempts).toBe(2);
    });
  });
});
