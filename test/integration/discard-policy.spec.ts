import { Controller } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { ClientProxy } from '@nestjs/microservices';

import { DiscardPolicy, jetstream, jetstreamManager, RetentionPolicy } from '@nats-io/jetstream';
import type { StreamInfo } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildSubject,
  getClientToken,
  JetstreamPublishError,
  PublishErrorReason,
  StreamKind,
  streamName,
} from '../../src';
import type { StreamConfigOverrides } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class OrdersController {
  public readonly received: unknown[] = [];

  @EventPattern('order.placed')
  public handlePlaced(@Payload() data: unknown): void {
    this.received.push(data);
  }

  @EventPattern('order.shipped')
  public handleShipped(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

describe('Stream discard policy', () => {
  let container: StartedTestContainer;
  let nc: NatsConnection;
  let port: number;
  let apps: INestApplication[] = [];
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
    for (const app of apps) await app.close();
    apps = [];
    await cleanupStreams(nc, serviceName);
  });

  /** Provision the event stream, then stop consuming so published messages stay in it. */
  const provisionIdleStream = async (stream?: StreamConfigOverrides): Promise<void> => {
    const { app } = await createTestApp({ name: serviceName, port, events: { stream } }, [
      OrdersController,
    ]);

    await app.close();
  };

  const publisher = async (): Promise<ClientProxy> => {
    const { app, module } = await createTestApp(
      { name: uniqueServiceName(), port },
      [],
      [serviceName],
    );

    apps.push(app);

    return module.get<ClientProxy>(getClientToken(serviceName));
  };

  const emitError = (client: ClientProxy, pattern: string): Promise<unknown> =>
    firstValueFrom(client.emit(pattern, { id: pattern })).then(
      () => undefined,
      (err: unknown) => err,
    );

  const eventStreamInfo = async (): Promise<StreamInfo> =>
    (await jetstreamManager(nc)).streams.info(streamName(serviceName, StreamKind.Event));

  it('should reject a publish once the stream is full', async () => {
    // Given
    serviceName = uniqueServiceName();
    await provisionIdleStream({ max_msgs: 1 });

    const client = await publisher();

    await firstValueFrom(client.emit('order.placed', { id: 1 }));

    // When
    const failure = await emitError(client, 'order.shipped');

    // Then: the publish fails instead of evicting the unconsumed message
    expect(failure).toBeInstanceOf(JetstreamPublishError);
    expect(failure).toMatchObject({
      reason: PublishErrorReason.StreamFull,
      message: 'maximum messages exceeded',
    });
    expect((await eventStreamInfo()).state.messages).toBe(1);
  });

  it('should reject a publish once one subject reaches its own limit', async () => {
    // Given
    serviceName = uniqueServiceName();
    await provisionIdleStream({ max_msgs_per_subject: 1 });

    const client = await publisher();

    await firstValueFrom(client.emit('order.placed', { id: 1 }));

    // When
    const sameSubject = await emitError(client, 'order.placed');
    const otherSubject = await emitError(client, 'order.shipped');

    // Then: only the full subject is refused
    expect(sameSubject).toMatchObject({
      reason: PublishErrorReason.StreamFull,
      message: 'maximum messages per subject exceeded',
    });
    expect(otherSubject).toBeUndefined();
    expect((await eventStreamInfo()).state.messages).toBe(2);
  });

  it('should keep evicting the oldest message when the override asks for discard old', async () => {
    // Given
    serviceName = uniqueServiceName();
    await provisionIdleStream({ discard: DiscardPolicy.Old, max_msgs: 1 });

    const client = await publisher();

    await firstValueFrom(client.emit('order.placed', { id: 1 }));

    // When
    const failure = await emitError(client, 'order.shipped');

    // Then
    expect(failure).toBeUndefined();

    const info = await eventStreamInfo();

    expect(info.config.discard).toBe(DiscardPolicy.Old);
    expect(info.config.discard_new_per_subject).toBeUndefined();
    expect(info.state.messages).toBe(1);
  });

  it('should switch a stream provisioned with the defaults to an override of discard old', async () => {
    // Given: the stream already rejects new messages per subject
    serviceName = uniqueServiceName();
    await provisionIdleStream();
    expect((await eventStreamInfo()).config).toMatchObject({
      discard: DiscardPolicy.New,
      discard_new_per_subject: true,
    });

    // When
    await provisionIdleStream({ discard: DiscardPolicy.Old });

    // Then
    const { config } = await eventStreamInfo();

    expect(config.discard).toBe(DiscardPolicy.Old);
    expect(config.discard_new_per_subject).toBeUndefined();
  });

  it('should switch a 3.0 stream to discard new in place, keeping its messages', async () => {
    // Given: a stream provisioned by 3.0, holding a message nobody consumed yet
    serviceName = uniqueServiceName();

    const jsm = await jetstreamManager(nc);
    const stream = streamName(serviceName, StreamKind.Event);

    await jsm.streams.add({
      name: stream,
      subjects: [buildSubject(serviceName, StreamKind.Event, '>')],
      retention: RetentionPolicy.Workqueue,
      discard: DiscardPolicy.Old,
      max_msgs_per_subject: 100_000,
    });
    await jetstream(nc).publish(
      buildSubject(serviceName, StreamKind.Event, 'order.placed'),
      JSON.stringify({ id: 'pre-upgrade' }),
    );

    // When
    const { app, module } = await createTestApp({ name: serviceName, port }, [OrdersController]);

    apps.push(app);

    // Then
    const controller = module.get(OrdersController);

    await waitForCondition(() => controller.received.length > 0, 15_000);
    expect(controller.received).toEqual([{ id: 'pre-upgrade' }]);
    expect((await jsm.streams.info(stream)).config).toMatchObject({
      discard: DiscardPolicy.New,
      discard_new_per_subject: true,
    });
  });
});

describe('Stream discard policy on the oldest supported server', () => {
  let container: StartedTestContainer;
  let nc: NatsConnection;
  let port: number;
  let serviceName: string;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer('nats:2.10'));
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
    await cleanupStreams(nc, serviceName);
  });

  it('should reject new messages per subject on NATS 2.10', async () => {
    // Given
    serviceName = uniqueServiceName();

    const { app } = await createTestApp({ name: serviceName, port }, [OrdersController]);

    await app.close();

    // When
    const info = await (
      await jetstreamManager(nc)
    ).streams.info(streamName(serviceName, StreamKind.Event));

    // Then
    expect(info.config).toMatchObject({
      discard: DiscardPolicy.New,
      discard_new_per_subject: true,
    });
  });
});
