import { Controller } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { ClientProxy } from '@nestjs/microservices';

import { jetstream, jetstreamManager, RetentionPolicy } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildSubject,
  getClientToken,
  StreamKind,
  streamName,
  STREAM_OWNER_METADATA_KEY,
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
class UpgradeController {
  public readonly received: unknown[] = [];

  @EventPattern('order.created')
  public handleOrder(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

/**
 * The upgrade path for services already running on 2.x: their streams predate
 * the ownership stamp, so the first 3.0 boot has to add it without disturbing
 * anything that is already in the stream.
 */
describe('stream upgrade from a pre-3.0 stream', () => {
  let container: StartedTestContainer;
  let nc: NatsConnection;
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

  /** Provision the event stream the way 2.x would have: no owner metadata. */
  const createLegacyStream = async (service: string): Promise<string> => {
    const jsm = await jetstreamManager(nc);
    const name = streamName(service, StreamKind.Event);

    await jsm.streams.add({
      name,
      subjects: [buildSubject(service, StreamKind.Event, '>')],
      retention: RetentionPolicy.Workqueue,
    });

    return name;
  };

  it('should adopt a stream that predates the ownership stamp', async () => {
    // Given a stream provisioned before 3.0, carrying no owner metadata
    serviceName = uniqueServiceName();

    const stream = await createLegacyStream(serviceName);
    const jsm = await jetstreamManager(nc);

    expect((await jsm.streams.info(stream)).config.metadata?.[STREAM_OWNER_METADATA_KEY]).toBe(
      undefined,
    );

    // When the service boots on 3.0
    const created = await createTestApp(
      { name: serviceName, port },
      [UpgradeController],
      [serviceName],
    );

    app = created.app;

    // Then the stream is adopted and stamped for the default connection
    const after = await jsm.streams.info(stream);

    expect(after.config.metadata?.[STREAM_OWNER_METADATA_KEY]).toBe(`${serviceName}:default`);
  });

  it('should not lose messages already sitting in a pre-3.0 stream', async () => {
    // Given a legacy stream holding a message published before the upgrade
    serviceName = uniqueServiceName();

    const stream = await createLegacyStream(serviceName);
    const js = jetstream(nc);

    await js.publish(
      buildSubject(serviceName, StreamKind.Event, 'order.created'),
      JSON.stringify({ id: 'pre-upgrade' }),
    );

    const jsm = await jetstreamManager(nc);

    expect((await jsm.streams.info(stream)).state.messages).toBe(1);

    // When the service boots on 3.0 and starts consuming
    const created = await createTestApp({ name: serviceName, port }, [UpgradeController]);

    app = created.app;

    const controller = created.module.get(UpgradeController);

    // Then the pre-existing message is delivered, not dropped by the upgrade
    await waitForCondition(() => controller.received.length > 0, 15_000);
    expect(controller.received).toEqual([{ id: 'pre-upgrade' }]);
  });

  it('should stop updating the stream once it carries the stamp', async () => {
    // Given a service that has already booted once on 3.0
    serviceName = uniqueServiceName();

    const first = await createTestApp({ name: serviceName, port }, [UpgradeController]);

    await first.app.close();

    const jsm = await jetstreamManager(nc);
    const stream = streamName(serviceName, StreamKind.Event);
    const firstBoot = await jsm.streams.info(stream);

    // When it boots a second time
    const second = await createTestApp({ name: serviceName, port }, [UpgradeController]);

    app = second.app;

    // Then the stream config is untouched: the stamp is not a permanent diff
    const secondBoot = await jsm.streams.info(stream);

    expect(secondBoot.config.metadata?.[STREAM_OWNER_METADATA_KEY]).toBe(
      firstBoot.config.metadata?.[STREAM_OWNER_METADATA_KEY],
    );
    expect(secondBoot.state.messages).toBe(firstBoot.state.messages);
  });

  it('should keep publishing to a service whose stream is externally owned', async () => {
    // Given a stream stamped by a completely different service
    serviceName = uniqueServiceName();

    const jsm = await jetstreamManager(nc);
    const stream = streamName(serviceName, StreamKind.Event);

    await jsm.streams.add({
      name: stream,
      subjects: [buildSubject(serviceName, StreamKind.Event, '>')],
      retention: RetentionPolicy.Workqueue,
      metadata: { [STREAM_OWNER_METADATA_KEY]: 'some-other-service:default' },
    });

    // When this service boots
    const created = await createTestApp(
      { name: serviceName, port },
      [UpgradeController],
      [serviceName],
    );

    app = created.app;

    const controller = created.module.get(UpgradeController);

    // Then a foreign service's stamp is not treated as a collision
    app.get<ClientProxy>(getClientToken(serviceName)).emit('order.created', { id: 'foreign' });

    await waitForCondition(() => controller.received.length > 0, 15_000);
    expect(controller.received).toEqual([{ id: 'foreign' }]);
  });
});
