import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, Ctx, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import type { NatsConnection } from '@nats-io/transport-node';
import { jetstreamManager } from '@nats-io/jetstream';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import {
  getClientToken,
  internalName,
  JetstreamRecordBuilder,
  RpcContext,
  StreamKind,
  streamName,
  toNanos,
} from '../../src';

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

@Controller()
class BroadcastScheduledController {
  public readonly received: unknown[] = [];

  @EventPattern('promo.start', { broadcast: true })
  handlePromo(@Payload() data: unknown): void {
    this.received.push(data);
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

  describe('concurrent schedules of the same pattern', () => {
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

    it('should deliver every pending schedule of the same pattern instead of replacing it', async () => {
      // Given: three schedules on the SAME pattern; per ADR-51 a shared
      // schedule subject would keep only the last one.
      const now = Date.now();

      const records = [1, 2, 3].map((orderId) =>
        new JetstreamRecordBuilder({ orderId }).scheduleAt(new Date(now + 2_000)).build(),
      );

      // When: emit all three before the first one fires
      for (const record of records) {
        await firstValueFrom(client.emit('order.reminder', record));
      }

      // Then: all three arrive
      await waitForCondition(() => controller.received.length >= 3, 15_000);

      const receivedOrderIds = controller.received.map((r) => (r as { orderId: number }).orderId);

      expect(receivedOrderIds.toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
    });

    it('should purge fired schedule messages so unique subjects do not accumulate', async () => {
      // Given: two messages scheduled on the same pattern
      const now = Date.now();

      const records = [1, 2].map((orderId) =>
        new JetstreamRecordBuilder({ orderId }).scheduleAt(new Date(now + 1_000)).build(),
      );

      for (const record of records) {
        await firstValueFrom(client.emit('order.reminder', record));
      }

      // When: both schedules fire and are delivered
      await waitForCondition(() => controller.received.length >= 2, 15_000);

      // Then: the server self-purges one-shot @at schedule holders after firing,
      // so per-message unique _sch subjects leave no residue in the workqueue stream
      const jsm = await jetstreamManager(nc);
      const stream = streamName(serviceName, StreamKind.Event);
      const scheduleFilter = `${internalName(serviceName)}._sch.>`;

      const countScheduleMessages = async (): Promise<number> => {
        const info = await jsm.streams.info(stream, { subjects_filter: scheduleFilter });

        return Object.values(info.state.subjects ?? {}).reduce((sum, n) => sum + n, 0);
      };

      await waitForCondition(async () => (await countScheduleMessages()) === 0, 10_000);

      expect(await countScheduleMessages()).toBe(0);
    });
  });

  describe('broadcast scheduling', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: BroadcastScheduledController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          broadcast: {
            stream: { allow_msg_schedules: true },
          },
        },
        [BroadcastScheduledController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(BroadcastScheduledController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should boot with broadcast scheduling enabled and deliver a scheduled broadcast', async () => {
      // Given: a broadcast scheduled 1.5s out
      const payload = { promo: 'summer' };

      const record = new JetstreamRecordBuilder(payload)
        .scheduleAt(new Date(Date.now() + 1_500))
        .build();

      // When
      await firstValueFrom(client.emit('broadcast:promo.start', record));

      // Then
      await waitForCondition(() => controller.received.length > 0, 10_000);

      expect(controller.received[0]).toEqual(payload);
    });
  });

  describe('scheduling combined with per-message TTL', () => {
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
            stream: { allow_msg_schedules: true, allow_msg_ttl: true },
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

    it('should deliver a scheduled message whose ttl is shorter than the schedule delay', async () => {
      // Given: ttl 1s, delivery scheduled 3s out; the ttl belongs to the
      // delivered message, so it must not expire the pending schedule
      const payload = { orderId: 7, reminder: true };

      const record = new JetstreamRecordBuilder(payload)
        .scheduleAt(new Date(Date.now() + 3_000))
        .ttl(toNanos(1, 'seconds'))
        .build();

      // When: emit and wait past the ttl and up to the schedule
      await firstValueFrom(client.emit('order.reminder', record));

      // Then: the message still fires at the scheduled time
      await waitForCondition(() => controller.received.length > 0, 10_000);

      expect(controller.received[0]).toEqual(payload);
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
