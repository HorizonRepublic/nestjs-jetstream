import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, Ctx, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import type { NatsConnection } from '@nats-io/transport-node';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { getClientToken, JetstreamRecordBuilder, RpcContext } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class ScheduledEventController {
  public readonly received: unknown[] = [];

  @EventPattern('order.reminder')
  handleReminder(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

@Controller()
class MultiPatternScheduledController {
  public readonly received: { pattern: string; data: unknown }[] = [];

  @EventPattern('order.reminder.a')
  handleA(@Payload() data: unknown): void {
    this.received.push({ pattern: 'order.reminder.a', data });
  }

  @EventPattern('order.reminder.b')
  handleB(@Payload() data: unknown): void {
    this.received.push({ pattern: 'order.reminder.b', data });
  }

  @EventPattern('order.reminder.c')
  handleC(@Payload() data: unknown): void {
    this.received.push({ pattern: 'order.reminder.c', data });
  }
}

@Controller()
class HeaderCapturingController {
  public readonly received: { data: unknown; tenantHeader: string | undefined }[] = [];

  @EventPattern('order.reminder')
  handleReminder(@Payload() data: unknown, @Ctx() ctx: RpcContext): void {
    this.received.push({
      data,
      tenantHeader: ctx.getHeader('x-tenant'),
    });
  }
}

describe('Message Scheduling (Delayed Jobs)', () => {
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
    let controller: ScheduledEventController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          events: {
            stream: { allow_msg_schedules: true },
          },
        },
        [ScheduledEventController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(ScheduledEventController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should deliver scheduled event after the specified delay', async () => {
      // Given: a message scheduled for 2 seconds from now
      const payload = { orderId: 42, reminder: true };
      const deliverAt = new Date(Date.now() + 2_000);

      const record = new JetstreamRecordBuilder(payload).scheduleAt(deliverAt).build();

      // When: emit scheduled event
      await firstValueFrom(client.emit('order.reminder', record));

      // Then: NOT delivered immediately
      await new Promise((r) => setTimeout(r, 500));

      expect(controller.received).toHaveLength(0);

      // Then: delivered after delay
      await waitForCondition(() => controller.received.length > 0, 10_000);

      expect(controller.received[0]).toEqual(payload);
    });

    it('should preserve message payload through scheduling', async () => {
      // Given: a complex payload scheduled for near-immediate delivery
      const payload = {
        id: 123,
        nested: { key: 'value' },
        array: [1, 2, 3],
      };

      const record = new JetstreamRecordBuilder(payload)
        .scheduleAt(new Date(Date.now() + 1_000))
        .build();

      // When: emit
      await firstValueFrom(client.emit('order.reminder', record));

      // Then: payload preserved
      await waitForCondition(() => controller.received.length > 0, 10_000);

      expect(controller.received[0]).toEqual(payload);
    });
  });

  describe('custom headers preserved through scheduling', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: HeaderCapturingController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          events: {
            stream: { allow_msg_schedules: true },
          },
        },
        [HeaderCapturingController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(HeaderCapturingController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should deliver scheduled message with custom headers intact', async () => {
      // Given: a scheduled message with a custom header
      const payload = { orderId: 99, reminder: true };

      const record = new JetstreamRecordBuilder(payload)
        .setHeader('x-tenant', 'acme')
        .scheduleAt(new Date(Date.now() + 1_000))
        .build();

      // When: emit scheduled event with custom header
      await firstValueFrom(client.emit('order.reminder', record));

      // Then: message arrives with payload and custom header preserved
      await waitForCondition(() => controller.received.length > 0, 10_000);

      expect(controller.received[0]!.data).toEqual(payload);
      expect(controller.received[0]!.tenantHeader).toBe('acme');
    });
  });

  describe('immediate events with scheduling enabled', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: ScheduledEventController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          events: {
            stream: { allow_msg_schedules: true },
          },
        },
        [ScheduledEventController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(ScheduledEventController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should deliver immediate event normally when allow_msg_schedules is enabled', async () => {
      // Given: a regular event payload (no scheduleAt)
      const payload = { orderId: 77, immediate: true };

      // When: emit without scheduling
      await firstValueFrom(client.emit('order.reminder', payload));

      // Then: delivered promptly (within a few seconds, no scheduling delay)
      await waitForCondition(() => controller.received.length > 0, 5_000);

      expect(controller.received[0]).toEqual(payload);
    });
  });

  describe('multiple scheduled messages', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: MultiPatternScheduledController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          events: {
            stream: { allow_msg_schedules: true },
          },
        },
        [MultiPatternScheduledController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(MultiPatternScheduledController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should deliver all scheduled messages on different subjects', async () => {
      // Given: three messages scheduled at staggered delays on different subjects
      // (NATS scheduling replaces previous schedule per _sch subject, so each
      //  message uses a distinct event pattern to avoid replacement)
      const now = Date.now();

      const recordA = new JetstreamRecordBuilder({ orderId: 1 })
        .scheduleAt(new Date(now + 1_000))
        .build();

      const recordB = new JetstreamRecordBuilder({ orderId: 2 })
        .scheduleAt(new Date(now + 2_000))
        .build();

      const recordC = new JetstreamRecordBuilder({ orderId: 3 })
        .scheduleAt(new Date(now + 3_000))
        .build();

      // When: emit all three scheduled events to different subjects
      await firstValueFrom(client.emit('order.reminder.a', recordA));
      await firstValueFrom(client.emit('order.reminder.b', recordB));
      await firstValueFrom(client.emit('order.reminder.c', recordC));

      // Then: all three messages arrive
      await waitForCondition(() => controller.received.length >= 3, 20_000);

      expect(controller.received).toHaveLength(3);

      const receivedOrderIds = controller.received.map(
        (r) => (r.data as { orderId: number }).orderId,
      );

      expect(receivedOrderIds).toContain(1);
      expect(receivedOrderIds).toContain(2);
      expect(receivedOrderIds).toContain(3);
    });
  });

  describe('messageId deduplication with scheduling', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: ScheduledEventController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          events: {
            stream: { allow_msg_schedules: true },
          },
        },
        [ScheduledEventController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(ScheduledEventController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should deduplicate scheduled messages with the same messageId', async () => {
      // Given: two scheduled messages with the same messageId
      const payload = { orderId: 55, reminder: true };
      const messageId = `dedup-test-${Date.now()}`;

      const record1 = new JetstreamRecordBuilder(payload)
        .setMessageId(messageId)
        .scheduleAt(new Date(Date.now() + 1_000))
        .build();

      const record2 = new JetstreamRecordBuilder(payload)
        .setMessageId(messageId)
        .scheduleAt(new Date(Date.now() + 1_500))
        .build();

      // When: publish the same message ID twice
      await firstValueFrom(client.emit('order.reminder', record1));
      await firstValueFrom(client.emit('order.reminder', record2));

      // Then: wait for the first delivery
      await waitForCondition(() => controller.received.length >= 1, 10_000);

      // Then: wait extra time to confirm no duplicate arrives
      await new Promise((r) => setTimeout(r, 3_000));

      expect(controller.received).toHaveLength(1);
      expect(controller.received[0]).toEqual(payload);
    });
  });

  describe('without allow_msg_schedules', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      // Given: a test app WITHOUT allow_msg_schedules (default event stream config)
      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
        },
        [ScheduledEventController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should reject scheduled publish when scheduling is not enabled on the stream', async () => {
      // Given: a scheduled message
      const payload = { orderId: 66, reminder: true };

      const record = new JetstreamRecordBuilder(payload)
        .scheduleAt(new Date(Date.now() + 2_000))
        .build();

      // When/Then: emit should reject because _sch subject is not in the stream
      await expect(firstValueFrom(client.emit('order.reminder', record))).rejects.toThrow();
    });
  });
});
