import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import type { NatsConnection } from '@nats-io/transport-node';
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
class ScheduledEventController {
  public readonly received: unknown[] = [];

  @EventPattern('order.reminder')
  handleReminder(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
});
