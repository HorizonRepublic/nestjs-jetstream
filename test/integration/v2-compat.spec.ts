import { Controller } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { ClientProxy } from '@nestjs/microservices';

import { jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildSubject,
  consumerName,
  getClientToken,
  JetstreamHealthIndicator,
  JetstreamStrategy,
  StreamKind,
  streamName,
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
class LegacyController {
  public readonly received: unknown[] = [];

  @EventPattern('order.created')
  public handleOrder(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

describe('v2 configuration compatibility', () => {
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

  it('should boot a flat forRoot config and deliver events', async () => {
    // Given the v2 flat form and the v2 bootstrap path
    serviceName = uniqueServiceName();

    const created = await createTestApp(
      { name: serviceName, port },
      [LegacyController],
      [serviceName],
    );

    app = created.app;

    const controller = created.module.get(LegacyController);
    const client = app.get<ClientProxy>(getClientToken(serviceName));

    // When an event is published through the bare service token
    client.emit('order.created', { id: 'o-1' });

    // Then the handler receives it
    await waitForCondition(() => controller.received.length > 0, 10_000);
    expect(controller.received).toEqual([{ id: 'o-1' }]);
  });

  it('should derive unchanged stream and consumer names', async () => {
    // Given a booted v2-style app
    serviceName = uniqueServiceName();

    const created = await createTestApp({ name: serviceName, port }, [LegacyController]);

    app = created.app;

    // When the server is inspected
    const jsm = await jetstreamManager(nc);
    const expectedStream = streamName(serviceName, StreamKind.Event);
    const streams = await jsm.streams.list().next();
    const consumers = await jsm.consumers.list(expectedStream).next();

    // Then names still follow the documented conventions
    expect(streams.map((s) => s.config.name)).toContain(expectedStream);
    expect(consumers.map((c) => c.name)).toContain(consumerName(serviceName, StreamKind.Event));
  });

  it('should return the v2 health shape for a single connection', async () => {
    // Given a single-connection app
    serviceName = uniqueServiceName();

    const created = await createTestApp({ name: serviceName, port }, [LegacyController]);

    app = created.app;

    // When health is checked
    const status = await app.get(JetstreamHealthIndicator).check();

    // Then the response carries exactly the pre-3.0 keys
    expect(Object.keys(status).toSorted()).toEqual(['connected', 'latency', 'server']);
    expect(status.connected).toBe(true);
  });

  it('should resolve a null strategy in publisher-only mode', async () => {
    // Given consumer: false, as examples/shared/bootstrap.ts guards against
    serviceName = uniqueServiceName();

    const created = await createTestApp(
      { name: serviceName, port, consumer: false },
      [],
      [serviceName],
    );

    app = created.app;

    // When the strategy is resolved
    const strategy = created.module.get(JetstreamStrategy, { strict: false });

    // Then it is null rather than a throwing provider
    expect(strategy).toBeNull();
  });

  it('should publish on the unchanged convention-derived subject', async () => {
    // Given a raw core subscriber on the subject the naming convention defines
    serviceName = uniqueServiceName();

    const created = await createTestApp(
      { name: serviceName, port },
      [LegacyController],
      [serviceName],
    );

    app = created.app;

    const subject = buildSubject(serviceName, StreamKind.Event, 'order.created');
    const observed: string[] = [];
    const subscription = nc.subscribe(subject);

    const collect = async (): Promise<void> => {
      for await (const msg of subscription) observed.push(msg.subject);
    };

    void collect();

    // When an event is published through the client
    app.get<ClientProxy>(getClientToken(serviceName)).emit('order.created', { id: 'o-2' });

    // Then it went out on exactly that subject
    await waitForCondition(() => observed.length > 0, 10_000);
    expect(observed[0]).toBe(subject);

    subscription.unsubscribe();
  });
});
