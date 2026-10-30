import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, Ctx, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AckExtensionConfig, DeadLetterInfo } from '../../src';
import { getClientToken, RpcContext, toNanos } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

const ACK_WAIT_MS = 1_000;
const HANDLER_MS = 400;
const MESSAGES = 8;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Delivery {
  readonly id: number;
  readonly deliveryCount: number | undefined;
}

interface Job {
  readonly id: number;
}

/** One handler at a time, slow enough that the backlog waits past ack_wait. */
@Controller()
class QueueController {
  public readonly deliveries: Delivery[] = [];

  @EventPattern<string>('job.run')
  public async onEvent(@Payload() job: Job, @Ctx() ctx: RpcContext): Promise<void> {
    this.deliveries.push({ id: job.id, deliveryCount: ctx.getDeliveryCount() });
    await sleep(HANDLER_MS);
  }

  @MessagePattern('job.call')
  public async onCommand(@Payload() job: Job, @Ctx() ctx: RpcContext): Promise<number> {
    this.deliveries.push({ id: job.id, deliveryCount: ctx.getDeliveryCount() });
    await sleep(HANDLER_MS);

    return job.id;
  }
}

describe('Messages parked behind the concurrency limit', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;
  let app: INestApplication | undefined;
  let serviceName: string;
  const deadLetters: DeadLetterInfo[] = [];

  const consumer = { ack_wait: toNanos(ACK_WAIT_MS / 1_000, 'seconds'), max_deliver: 3 };

  const startEvents = async (
    ackExtension: AckExtensionConfig,
  ): Promise<{ client: ClientProxy; sut: QueueController }> => {
    const created = await createTestApp(
      {
        name: serviceName,
        port,
        events: { consumer, concurrency: 1, ackExtension },
        onDeadLetter: async (info) => {
          deadLetters.push(info);
        },
      },
      [QueueController],
      [serviceName],
    );

    app = created.app;

    return {
      client: created.module.get<ClientProxy>(getClientToken(serviceName)),
      sut: created.module.get(QueueController),
    };
  };

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

  beforeEach(() => {
    serviceName = uniqueServiceName();
    deadLetters.length = 0;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await cleanupStreams(nc, serviceName);
  });

  it('keeps parked events alive past ack_wait when ack extension is off', async () => {
    // Given one handler slot and a backlog that takes several ack_waits to drain
    const { client, sut } = await startEvents(false);

    // When the whole backlog arrives at once
    for (let id = 0; id < MESSAGES; id++) {
      await firstValueFrom(client.emit('job.run', { id }));
    }

    // Then every event runs once, on its first delivery, and nothing is dead-lettered
    await waitForCondition(() => sut.deliveries.length >= MESSAGES, 20_000);
    await sleep(ACK_WAIT_MS * 2);

    expect(sut.deliveries).toHaveLength(MESSAGES);
    expect(sut.deliveries.every((delivery) => delivery.deliveryCount === 1)).toBe(true);
    expect(deadLetters).toHaveLength(0);
  }, 40_000);

  it('does not count queue time against ackExtension.maxDuration', async () => {
    // Given an extension cap shorter than the time the last event waits for its slot
    const { client, sut } = await startEvents({ maxDuration: ACK_WAIT_MS });

    // When the whole backlog arrives at once
    for (let id = 0; id < MESSAGES; id++) {
      await firstValueFrom(client.emit('job.run', { id }));
    }

    // Then the parked events are still delivered once each
    await waitForCondition(() => sut.deliveries.length >= MESSAGES, 20_000);
    await sleep(ACK_WAIT_MS * 2);

    expect(sut.deliveries).toHaveLength(MESSAGES);
    expect(sut.deliveries.every((delivery) => delivery.deliveryCount === 1)).toBe(true);
  }, 40_000);

  it('keeps parked commands alive past ack_wait', async () => {
    // Given JetStream RPC with one handler slot and a short ack_wait
    const created = await createTestApp(
      {
        name: serviceName,
        port,
        rpc: { mode: 'jetstream', timeout: 30_000, concurrency: 1, consumer },
        onDeadLetter: async (info) => {
          deadLetters.push(info);
        },
      },
      [QueueController],
      [serviceName],
    );

    app = created.app;
    const client = created.module.get<ClientProxy>(getClientToken(serviceName));
    const sut = created.module.get(QueueController);

    // When several commands arrive at once
    const ids = Array.from({ length: MESSAGES }, (_, id) => id);
    const replies = await Promise.all(
      ids.map((id) => firstValueFrom(client.send('job.call', { id }))),
    );

    await sleep(ACK_WAIT_MS * 2);

    // Then each one is handled once and answered, and none is dead-lettered
    expect(replies).toEqual(ids);
    expect(sut.deliveries).toHaveLength(MESSAGES);
    expect(deadLetters).toHaveLength(0);
  }, 40_000);
});
