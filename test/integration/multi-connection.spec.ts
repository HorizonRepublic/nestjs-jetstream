import { Controller } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { ClientProxy } from '@nestjs/microservices';

import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getClientToken, JetstreamConnection, StreamKind, streamName } from '../../src';
import { createMultiConnectionApp, uniqueServiceName, waitForCondition } from './helpers';
import { startNatsContainer } from './nats-container';

const received: string[] = [];

@Controller()
class PrimaryController {
  @EventPattern('order.created')
  public onOrder(@Payload() data: { id: string }): void {
    received.push(`primary:${data.id}`);
  }
}

@JetstreamConnection('analytics')
@Controller()
class AnalyticsController {
  @EventPattern('page.viewed')
  public onView(@Payload() data: { id: string }): void {
    received.push(`analytics:${data.id}`);
  }
}

@Controller()
class TwinController {
  @EventPattern('twin.event', { connection: 'analytics' })
  public onTwin(@Payload() data: { id: string }): void {
    received.push(`twin-analytics:${data.id}`);
  }
}

describe('multi-connection routing', () => {
  let primaryContainer: StartedTestContainer;
  let analyticsContainer: StartedTestContainer;
  let primaryPort: number;
  let analyticsPort: number;
  let app: INestApplication;
  let serviceName: string;

  beforeAll(async () => {
    const [primary, analytics] = await Promise.all([startNatsContainer(), startNatsContainer()]);

    primaryContainer = primary.container;
    primaryPort = primary.port;
    analyticsContainer = analytics.container;
    analyticsPort = analytics.port;

    serviceName = uniqueServiceName();

    ({ app } = await createMultiConnectionApp({
      name: serviceName,
      connections: {
        primary: { servers: [`nats://localhost:${primaryPort}`] },
        analytics: { servers: [`nats://localhost:${analyticsPort}`] },
      },
      defaultConnection: 'primary',
      controllers: [PrimaryController, AnalyticsController, TwinController],
      clients: [{ name: serviceName }, { name: serviceName, connection: 'analytics' }],
    }));
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([primaryContainer.stop(), analyticsContainer.stop()]);
  });

  afterEach(() => {
    received.length = 0;
  });

  it('should deliver an unqualified handler through the default connection', async () => {
    // Given a client on the default connection
    const client = app.get<ClientProxy>(getClientToken(serviceName));

    // When an event is published
    client.emit('order.created', { id: 'o-1' });

    // Then the default connection's handler receives it
    await waitForCondition(() => received.includes('primary:o-1'), 10_000);
    expect(received).toContain('primary:o-1');
  });

  it('should deliver a class-decorated handler through its named connection', async () => {
    // Given a client bound to the analytics connection
    const client = app.get<ClientProxy>(getClientToken(serviceName, 'analytics'));

    // When an event is published there
    client.emit('page.viewed', { id: 'v-1' });

    // Then the analytics handler receives it
    await waitForCondition(() => received.includes('analytics:v-1'), 10_000);
    expect(received).toContain('analytics:v-1');
  });

  it('should honor a method-level connection override', async () => {
    // Given a handler bound through method extras
    const client = app.get<ClientProxy>(getClientToken(serviceName, 'analytics'));

    // When the event is published on that connection
    client.emit('twin.event', { id: 't-1' });

    // Then it is handled
    await waitForCondition(() => received.includes('twin-analytics:t-1'), 10_000);
    expect(received).toContain('twin-analytics:t-1');
  });

  it('should isolate clusters: an event published on one is not seen on the other', async () => {
    // Given a client on the primary connection
    const client = app.get<ClientProxy>(getClientToken(serviceName));

    // When a pattern owned by analytics is published on primary
    client.emit('page.viewed', { id: 'v-cross' });

    // Then the analytics handler never sees it
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(received).not.toContain('analytics:v-cross');
  });

  it('should create each connection its own streams on its own cluster', async () => {
    // Given both clusters
    const primaryNc = await connect({ servers: [`nats://localhost:${primaryPort}`] });
    const analyticsNc = await connect({ servers: [`nats://localhost:${analyticsPort}`] });

    // When streams are listed
    const primaryStreams = await (await jetstreamManager(primaryNc)).streams.list().next();
    const analyticsStreams = await (await jetstreamManager(analyticsNc)).streams.list().next();

    // Then the same convention-derived name exists on both, independently
    const expected = streamName(serviceName, StreamKind.Event);

    expect(primaryStreams.map((s) => s.config.name)).toContain(expected);
    expect(analyticsStreams.map((s) => s.config.name)).toContain(expected);

    await primaryNc.drain();
    await analyticsNc.drain();
  });
});
