import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';

import { jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DeadLetterInfo, JetstreamModuleOptions } from '../../src';
import {
  dlqStreamName,
  getClientToken,
  internalName,
  JetstreamDlqHeader,
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

const ACK_WAIT_MS = 1_000;

/** Lets the hanging handlers return once a test is done with them. */
let releaseHandlers: () => void = () => undefined;
let handlersReleased: Promise<void> = Promise.resolve();

const holdHandlers = (): void => {
  handlersReleased = new Promise((resolve) => {
    releaseHandlers = resolve;
  });
};

/** Never settles while held: every delivery runs out its ack_wait. */
@Controller()
class HangingController {
  public attempts = 0;

  @EventPattern('order.stuck')
  public async onEvent(@Payload() _data: unknown): Promise<void> {
    this.attempts++;
    await handlersReleased;
  }

  @EventPattern('config.stuck', { broadcast: true })
  public async onBroadcast(@Payload() _data: unknown): Promise<void> {
    this.attempts++;
    await handlersReleased;
  }
}

describe('Dead letters from unsettled deliveries', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;
  let apps: INestApplication[] = [];
  let serviceName: string;
  const deadLetters: DeadLetterInfo[] = [];

  const options = (): Partial<JetstreamModuleOptions> & { name: string; port: number } => ({
    name: serviceName,
    port,
    events: { consumer: { max_deliver: 2, ack_wait: toNanos(ACK_WAIT_MS / 1_000, 'seconds') } },
    broadcast: { consumer: { max_deliver: 2, ack_wait: toNanos(ACK_WAIT_MS / 1_000, 'seconds') } },
    onDeadLetter: async (info) => {
      deadLetters.push(info);
    },
  });

  const start = async (): Promise<{ client: ClientProxy; controller: HangingController }> => {
    const { app, module } = await createTestApp(options(), [HangingController], [serviceName]);

    apps.push(app);

    return {
      client: module.get<ClientProxy>(getClientToken(serviceName)),
      controller: module.get(HangingController),
    };
  };

  const streamMessages = async (name: string): Promise<number> => {
    const jsm = await jetstreamManager(nc);

    return (await jsm.streams.info(name)).state.messages;
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
    holdHandlers();
  });

  afterEach(async () => {
    releaseHandlers();
    await Promise.all(apps.map((app) => app.close()));
    apps = [];
    await cleanupStreams(nc, serviceName);
  });

  it('moves an event whose deliveries all ran out to the DLQ and off the stream', async () => {
    // Given a handler that never settles within ack_wait
    const { client, controller } = await start();

    // When one event is published
    await firstValueFrom(client.emit('order.stuck', { id: 7 }));

    // Then once both deliveries lapse it is dead-lettered exactly once
    await waitForCondition(() => deadLetters.length > 0, 15_000);
    await waitForCondition(
      async () => (await streamMessages(streamName(serviceName, StreamKind.Event))) === 0,
      5_000,
    );

    expect(controller.attempts).toBe(2);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      subject: `${internalName(serviceName)}.ev.order.stuck`,
      data: { id: 7 },
      deliveryCount: 2,
    });

    const dlq = dlqStreamName(serviceName);
    const jsm = await jetstreamManager(nc);
    const entry = await jsm.streams.getMessage(dlq, { last_by_subj: dlq });

    expect(await streamMessages(dlq)).toBe(1);
    expect(entry?.header.get(JetstreamDlqHeader.DeliveryCount)).toBe('2');
  }, 30_000);

  it('dead-letters a broadcast without removing it from the shared stream', async () => {
    // Given the same hanging handler on a broadcast subject
    const { client } = await start();

    // When one broadcast is published
    await firstValueFrom(client.emit('broadcast:config.stuck', { v: 1 }));

    // Then it is captured, and the broadcast stream still holds it for other services
    await waitForCondition(() => deadLetters.length > 0, 15_000);

    expect(deadLetters).toHaveLength(1);
    expect(await streamMessages(dlqStreamName(serviceName))).toBe(1);
    expect(await streamMessages(streamName(serviceName, StreamKind.Broadcast))).toBe(1);
  }, 30_000);

  it('captures once when several instances of the service are running', async () => {
    // Given two instances of one service
    const { client } = await start();

    await start();

    // When one event exhausts its deliveries
    await firstValueFrom(client.emit('order.stuck', { id: 8 }));
    await waitForCondition(() => deadLetters.length > 0, 15_000);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Then exactly one instance captured it
    expect(deadLetters).toHaveLength(1);
    expect(await streamMessages(dlqStreamName(serviceName))).toBe(1);
  }, 30_000);
});
