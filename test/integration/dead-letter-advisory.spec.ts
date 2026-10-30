import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DeadLetterInfo, JetstreamModuleOptions } from '../../src';
import {
  consumerName,
  dlqStreamName,
  getClientToken,
  internalName,
  JetstreamDeliveryError,
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

/** Long enough for a second replica to start before the abandoned command expires. */
const COMMAND_ACK_WAIT_MS = 4_000;

/** Lets the hanging handlers return once a test is done with them. */
let releaseHandlers: () => void = () => undefined;
let handlersReleased: Promise<void> = Promise.resolve();

const holdHandlers = (): void => {
  handlersReleased = new Promise((resolve) => {
    releaseHandlers = resolve;
  });
};

/** Never settles while held: every delivery runs out its ack_wait, and the last one counts as hung. */
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

/** Outlives ack_wait on its only delivery, then succeeds or throws. */
@Controller()
class OverrunController {
  public completed = 0;

  @EventPattern('order.overrun')
  public async onOverrun(@Payload() _data: unknown): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ACK_WAIT_MS * 3));
    this.completed++;
  }

  @EventPattern('order.overrun-fails')
  public async onOverrunFails(@Payload() _data: unknown): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ACK_WAIT_MS * 3));
    this.completed++;
    throw new Error('handler failed late');
  }
}

/** A command handler that answers after the command's ack_wait ran out. */
@Controller()
class SlowCommandController {
  public completed = 0;

  @MessagePattern('order.slow-command')
  public async onCommand(@Payload() data: unknown): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, ACK_WAIT_MS * 3));
    this.completed++;

    return data;
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
    // A handler past maxDuration counts as hung, so its message is captured while it runs.
    events: {
      consumer: { max_deliver: 2, ack_wait: toNanos(ACK_WAIT_MS / 1_000, 'seconds') },
      ackExtension: { maxDuration: ACK_WAIT_MS },
    },
    broadcast: {
      consumer: { max_deliver: 2, ack_wait: toNanos(ACK_WAIT_MS / 1_000, 'seconds') },
      ackExtension: { maxDuration: ACK_WAIT_MS },
    },
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
    // Given a hung handler
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
  describe('when the handler of the final delivery is still running here', () => {
    const startOverrun = async (): Promise<{
      client: ClientProxy;
      controller: OverrunController;
    }> => {
      const { app, module } = await createTestApp(
        {
          ...options(),
          events: {
            consumer: { max_deliver: 1, ack_wait: toNanos(ACK_WAIT_MS / 1_000, 'seconds') },
          },
        },
        [OverrunController],
        [serviceName],
      );

      apps.push(app);

      return {
        client: module.get<ClientProxy>(getClientToken(serviceName)),
        controller: module.get(OverrunController),
      };
    };

    it('lets a handler that succeeds late settle the message instead of dead-lettering it', async () => {
      // Given a handler that outlives ack_wait on the only delivery allowed
      const { client, controller } = await startOverrun();

      // When an event is published and its handler finishes after the server gave up
      await firstValueFrom(client.emit('order.overrun', { id: 9 }));
      await waitForCondition(() => controller.completed === 1, 15_000);
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // Then its ack removes it, and nothing reaches the DLQ
      expect(deadLetters).toHaveLength(0);
      expect(await streamMessages(streamName(serviceName, StreamKind.Event))).toBe(0);
      expect(await streamMessages(dlqStreamName(serviceName))).toBe(0);
    }, 30_000);

    it('dead-letters once when that handler fails late', async () => {
      // Given a handler that outlives ack_wait and then throws
      const { client, controller } = await startOverrun();

      // When an event is published
      await firstValueFrom(client.emit('order.overrun-fails', { id: 10 }));
      await waitForCondition(() => controller.completed === 1, 15_000);
      await waitForCondition(() => deadLetters.length > 0, 5_000);
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // Then the handler's own error is what reaches the DLQ, once
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]?.error).toMatchObject({ status: 'error' });
      expect(deadLetters[0]?.error).not.toBeInstanceOf(JetstreamDeliveryError);
      expect(await streamMessages(dlqStreamName(serviceName))).toBe(1);
      expect(await streamMessages(streamName(serviceName, StreamKind.Event))).toBe(0);
    }, 30_000);

    it('captures the message on shutdown instead of losing it with the waiting capture', async () => {
      // Given a hung handler on the only delivery, whose advisory is waiting on it
      const { app, module } = await createTestApp(
        {
          ...options(),
          shutdownTimeout: 3_000,
          events: {
            consumer: { max_deliver: 1, ack_wait: toNanos(ACK_WAIT_MS / 1_000, 'seconds') },
          },
        },
        [HangingController],
        [serviceName],
      );
      const client = module.get<ClientProxy>(getClientToken(serviceName));
      const controller = module.get(HangingController);

      await firstValueFrom(client.emit('order.stuck', { id: 13 }));
      await waitForCondition(() => controller.attempts === 1, 5_000);
      await new Promise((resolve) => setTimeout(resolve, ACK_WAIT_MS * 3));

      expect(deadLetters).toHaveLength(0);

      // When the service shuts down while the handler still hangs
      await app.close();

      // Then the message is dead-lettered before the connection drains
      expect(deadLetters).toHaveLength(1);
      expect(await streamMessages(streamName(serviceName, StreamKind.Event))).toBe(0);
      expect(await streamMessages(dlqStreamName(serviceName))).toBe(1);
    }, 30_000);
  });

  describe('commands', () => {
    const rpc = {
      mode: 'jetstream',
      timeout: 30_000,
      consumer: { ack_wait: toNanos(COMMAND_ACK_WAIT_MS / 1_000, 'seconds') },
    } as const;

    it('dead-letters a command whose only delivery was abandoned, and removes it', async () => {
      // Given the service's command stream and consumer exist, with no replica running
      const first = await createTestApp(
        { ...options(), rpc },
        [SlowCommandController],
        [serviceName],
      );

      await first.app.close();

      const subject = `${internalName(serviceName)}.cmd.order.slow-command`;
      const commandStream = streamName(serviceName, StreamKind.Command);

      await jetstream(nc).publish(subject, JSON.stringify({ id: 11 }));

      // When a replica takes the command and dies without settling it
      const consumer = await jetstream(nc).consumers.get(
        commandStream,
        consumerName(serviceName, StreamKind.Command),
      );
      const taken = await consumer.next({ expires: 5_000 });

      expect(taken?.info.deliveryCount).toBe(1);

      const { app } = await createTestApp(
        { ...options(), rpc },
        [SlowCommandController],
        [serviceName],
      );

      apps.push(app);

      // Then once its ack_wait runs out it is dead-lettered and leaves the command stream
      await waitForCondition(() => deadLetters.length > 0, 15_000);
      await waitForCondition(async () => (await streamMessages(commandStream)) === 0, 5_000);

      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]).toMatchObject({ subject, data: { id: 11 }, deliveryCount: 1 });
      expect(await streamMessages(dlqStreamName(serviceName))).toBe(1);
    }, 40_000);

    it('lets a command handler that answers late settle the command', async () => {
      // Given a command handler that outlives the command's ack_wait
      const { app, module } = await createTestApp(
        {
          ...options(),
          rpc: {
            ...rpc,
            consumer: { ack_wait: toNanos(ACK_WAIT_MS / 1_000, 'seconds') },
          },
        },
        [SlowCommandController],
        [serviceName],
      );

      apps.push(app);
      const client = module.get<ClientProxy>(getClientToken(serviceName));

      // When it is called
      const reply = await firstValueFrom(client.send('order.slow-command', { id: 12 }));

      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // Then the caller gets the answer and nothing is dead-lettered
      expect(reply).toEqual({ id: 12 });
      expect(deadLetters).toHaveLength(0);
      expect(await streamMessages(streamName(serviceName, StreamKind.Command))).toBe(0);
      expect(await streamMessages(dlqStreamName(serviceName))).toBe(0);
    }, 30_000);
  });
});
