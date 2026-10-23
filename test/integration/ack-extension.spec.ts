import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';

import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getClientToken, toNanos } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

const ACK_WAIT_MS = 2_000;
const SLOW_HANDLER_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs longer than ack_wait, so the message is redelivered unless it is kept alive. */
@Controller()
class SlowHandlerController {
  public attempts = 0;
  public completions = 0;

  @EventPattern('order.slow')
  public async handleSlow(@Payload() _data: unknown): Promise<void> {
    this.attempts++;
    await sleep(SLOW_HANDLER_MS);
    this.completions++;
  }
}

/** Records overlap so a concurrency limit can be asserted rather than assumed. */
@Controller()
class OverlapController {
  public active = 0;
  public peakActive = 0;
  public completed = 0;

  @EventPattern('order.overlap')
  public async handleOverlap(@Payload() _data: unknown): Promise<void> {
    this.active++;
    this.peakActive = Math.max(this.peakActive, this.active);
    await sleep(300);
    this.active--;
    this.completed++;
  }
}

describe('Ack extension and concurrency', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;
  let app: INestApplication | undefined;
  let serviceName: string;

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

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await cleanupStreams(nc, serviceName);
  });

  describe('ackExtension', () => {
    it('keeps a handler that outlives ack_wait from being redelivered', async () => {
      // Given a handler that runs more than twice as long as ack_wait
      serviceName = uniqueServiceName();

      const created = await createTestApp(
        {
          name: serviceName,
          port,
          events: {
            consumer: { ack_wait: toNanos(ACK_WAIT_MS / 1_000, 'seconds'), max_deliver: 3 },
            ackExtension: true,
          },
        },
        [SlowHandlerController],
        [serviceName],
      );

      app = created.app;
      const sut = created.module.get(SlowHandlerController);
      const client = created.module.get<ClientProxy>(getClientToken(serviceName));

      // When one message is published
      await firstValueFrom(client.emit('order.slow', { id: 1 }));

      // Then it completes once, without the server redelivering mid-handler
      await waitForCondition(() => sut.completions === 1, SLOW_HANDLER_MS + 10_000);
      await sleep(ACK_WAIT_MS);

      expect(sut.attempts).toBe(1);
      expect(sut.completions).toBe(1);
    });

    it('lets the server redeliver when extension is off', async () => {
      // Given the same slow handler with ack extension disabled
      serviceName = uniqueServiceName();

      const created = await createTestApp(
        {
          name: serviceName,
          port,
          events: {
            consumer: { ack_wait: toNanos(ACK_WAIT_MS / 1_000, 'seconds'), max_deliver: 3 },
            ackExtension: false,
          },
        },
        [SlowHandlerController],
        [serviceName],
      );

      app = created.app;
      const sut = created.module.get(SlowHandlerController);
      const client = created.module.get<ClientProxy>(getClientToken(serviceName));

      // When one message is published
      await firstValueFrom(client.emit('order.slow', { id: 1 }));

      // Then ack_wait expires while the handler is still running and it arrives again
      await waitForCondition(() => sut.attempts >= 2, SLOW_HANDLER_MS + 10_000);

      expect(sut.attempts).toBeGreaterThanOrEqual(2);
    });

    it('stops extending at maxDuration and lets the server redeliver', async () => {
      // Given extension capped well under the handler's run time
      serviceName = uniqueServiceName();

      const created = await createTestApp(
        {
          name: serviceName,
          port,
          events: {
            consumer: { ack_wait: toNanos(ACK_WAIT_MS / 1_000, 'seconds'), max_deliver: 3 },
            ackExtension: { maxDuration: ACK_WAIT_MS },
          },
        },
        [SlowHandlerController],
        [serviceName],
      );

      app = created.app;
      const sut = created.module.get(SlowHandlerController);
      const client = created.module.get<ClientProxy>(getClientToken(serviceName));

      // When one message is published
      await firstValueFrom(client.emit('order.slow', { id: 1 }));

      // Then the extension lapses mid-handler and the message arrives again
      await waitForCondition(() => sut.attempts >= 2, SLOW_HANDLER_MS + 10_000);

      expect(sut.attempts).toBeGreaterThanOrEqual(2);
    });
  });

  describe('concurrency', () => {
    it('runs one handler at a time and still delivers every parked message', async () => {
      // Given a consumer limited to one in-flight handler
      serviceName = uniqueServiceName();

      const created = await createTestApp(
        {
          name: serviceName,
          port,
          events: { concurrency: 1, ackExtension: true },
        },
        [OverlapController],
        [serviceName],
      );

      app = created.app;
      const sut = created.module.get(OverlapController);
      const client = created.module.get<ClientProxy>(getClientToken(serviceName));

      // When four messages arrive faster than the handler drains them
      for (let i = 0; i < 4; i++) {
        await firstValueFrom(client.emit('order.overlap', { id: i }));
      }

      // Then none of them overlap, and the parked ones are handled rather than redelivered
      await waitForCondition(() => sut.completed === 4, 20_000);

      expect(sut.peakActive).toBe(1);
      expect(sut.completed).toBe(4);
    });
  });
});
