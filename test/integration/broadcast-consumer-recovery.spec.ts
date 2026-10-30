import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';

import { DeliverPolicy, jetstreamManager, type JetStreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { consumerName, getClientToken, StreamKind, streamName } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

interface Tick {
  readonly seq: number;
}

@Controller()
class TickController {
  public readonly received: Tick[] = [];

  @EventPattern('tick', { broadcast: true })
  public handle(@Payload() data: Tick): void {
    this.received.push(data);
  }
}

/** Longer than the interval at which a broadcast consumer's position is refreshed. */
const POSITION_REFRESH_WAIT_MS = 11_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('Broadcast consumer recovery', () => {
  let container: StartedTestContainer;
  let port: number;
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  let app: INestApplication;
  let module: TestingModule;
  let client: ClientProxy;
  let controller: TickController;
  let serviceName: string;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);
    jsm = await jetstreamManager(nc);
  }, 60_000);

  afterAll(async () => {
    try {
      await nc.drain();
    } finally {
      await container.stop();
    }
  });

  beforeEach(async () => {
    serviceName = uniqueServiceName();
    ({ app, module } = await createTestApp(
      { name: serviceName, port, broadcast: { consume: { idle_heartbeat: 1_000 } } },
      [TickController],
      [serviceName],
    ));
    client = module.get<ClientProxy>(getClientToken(serviceName));
    controller = module.get(TickController);
  });

  afterEach(async () => {
    await app.close().catch(() => undefined);
    await cleanupStreams(nc, serviceName).catch(() => undefined);
  });

  const emit = async (seq: number): Promise<void> => {
    await firstValueFrom(client.emit('broadcast:tick', { seq }));
  };

  it('should resume a recreated broadcast consumer after what it already acknowledged', async () => {
    // Given: five broadcasts handled and acknowledged
    const stream = streamName(serviceName, StreamKind.Broadcast);
    const durable = consumerName(serviceName, StreamKind.Broadcast);

    for (let seq = 1; seq <= 5; seq++) await emit(seq);

    await waitForCondition(
      async () => (await jsm.consumers.info(stream, durable)).ack_floor.stream_seq >= 5,
      10_000,
    );
    await sleep(POSITION_REFRESH_WAIT_MS);

    // When: the durable vanishes and more broadcasts arrive while it is gone
    await jsm.consumers.delete(stream, durable);
    await emit(6);
    await emit(7);

    // Then: only what was published after the acknowledged history is delivered
    await waitForCondition(() => controller.received.some((t) => t.seq === 7), 30_000);
    await sleep(1_000);

    expect(controller.received.map((t) => t.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const recreated = await jsm.consumers.info(stream, durable);

    expect(recreated.config.deliver_policy).toBe(DeliverPolicy.StartSequence);
    expect(recreated.config.opt_start_seq).toBe(6);
  }, 60_000);

  it('should start a recreated consumer from the beginning when the stream was recreated too', async () => {
    // Given: acknowledged history whose sequences the recreated stream starts over
    const stream = streamName(serviceName, StreamKind.Broadcast);
    const durable = consumerName(serviceName, StreamKind.Broadcast);

    for (let seq = 1; seq <= 5; seq++) await emit(seq);

    await waitForCondition(
      async () => (await jsm.consumers.info(stream, durable)).ack_floor.stream_seq >= 5,
      10_000,
    );
    await sleep(POSITION_REFRESH_WAIT_MS);

    const { config } = await jsm.streams.info(stream);

    // When: an operator deletes and recreates the stream
    await jsm.streams.delete(stream);
    await jsm.streams.add(config);
    await emit(6);
    await emit(7);

    // Then: the broadcasts on the new stream arrive
    await waitForCondition(() => controller.received.some((t) => t.seq === 7), 45_000);

    expect(controller.received.map((t) => t.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  }, 90_000);

  it('should recreate a consumer whose start sequence lies past the end of the stream', async () => {
    // Given: a durable left starting beyond anything the stream will hold soon
    const stream = streamName(serviceName, StreamKind.Broadcast);
    const durable = consumerName(serviceName, StreamKind.Broadcast);

    for (let seq = 1; seq <= 3; seq++) await emit(seq);

    await waitForCondition(() => controller.received.length >= 3, 10_000);

    const { config } = await jsm.consumers.info(stream, durable);

    await app.close();
    await jsm.consumers.delete(stream, durable);
    await jsm.consumers.add(stream, {
      ...config,
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: 1_000_000,
    });

    // When
    ({ app, module } = await createTestApp({ name: serviceName, port }, [TickController], []));

    // Then: the boot replaces it with one that delivers what the stream holds
    const info = await jsm.consumers.info(stream, durable);

    expect(info.config.deliver_policy).toBe(DeliverPolicy.All);
    await waitForCondition(() => module.get(TickController).received.length >= 3, 10_000);
  }, 60_000);

  it('should boot against a broadcast consumer that resumed from a sequence', async () => {
    // Given: the durable was recreated from a stream sequence
    const stream = streamName(serviceName, StreamKind.Broadcast);
    const durable = consumerName(serviceName, StreamKind.Broadcast);

    for (let seq = 1; seq <= 3; seq++) await emit(seq);

    await waitForCondition(() => controller.received.length >= 3, 10_000);

    const { config } = await jsm.consumers.info(stream, durable);

    await jsm.consumers.delete(stream, durable);
    await jsm.consumers.add(stream, {
      ...config,
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: 4,
    });
    await app.close();

    // When
    ({ app, module } = await createTestApp({ name: serviceName, port }, [TickController], []));
    controller = module.get(TickController);

    // Then: the boot keeps the resume position instead of failing on the immutable start
    const info = await jsm.consumers.info(stream, durable);

    expect(info.config.deliver_policy).toBe(DeliverPolicy.StartSequence);
    expect(info.config.opt_start_seq).toBe(4);
  }, 60_000);
});
