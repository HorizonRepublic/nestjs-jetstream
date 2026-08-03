import { Controller } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { ClientProxy } from '@nestjs/microservices';

import type { NatsConnection } from '@nats-io/transport-node';

import { Registry } from 'prom-client';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getClientToken, JetstreamConnection, TransportEvent } from '../../src';
import {
  cleanupStreams,
  createMultiConnectionApp,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

/** Every argument every hook invocation received, so arity can be asserted. */
const hookCalls: unknown[][] = [];

@Controller()
class GuardController {
  @EventPattern('guard.event')
  public onEvent(@Payload() _data: unknown): void {}
}

@JetstreamConnection('secondary')
@Controller()
class SecondaryGuardController {
  @EventPattern('guard.secondary')
  public onEvent(@Payload() _data: unknown): void {}
}

/**
 * The multi-connection work must be invisible to a service that configures one
 * connection. These tests assert the observable surface of the default path,
 * not the internals.
 */
describe('single-connection behaviour is unchanged', () => {
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
    hookCalls.length = 0;
    await cleanupStreams(nc, serviceName);
  });

  it('should not append a connection argument to hooks', async () => {
    // Given a flat single-connection service with hooks registered
    serviceName = uniqueServiceName();

    const created = await createTestApp(
      {
        name: serviceName,
        port,
        hooks: {
          [TransportEvent.MessageRouted]: (...args: unknown[]) => hookCalls.push(args),
          [TransportEvent.HandlerCompleted]: (...args: unknown[]) => hookCalls.push(args),
        },
      },
      [GuardController],
      [serviceName],
    );

    app = created.app;

    // When a message flows end to end
    await firstValueFrom(
      app.get<ClientProxy>(getClientToken(serviceName)).emit('guard.event', { id: 1 }),
    );

    await waitForCondition(() => hookCalls.length >= 2, 15_000);

    // Then no invocation carries a trailing connection name: MessageRouted keeps
    // its two arguments and HandlerCompleted its four, exactly as before
    const arities = hookCalls.map((args) => args.length).toSorted((a, b) => a - b);

    expect(arities).toEqual([2, 4]);
    expect(hookCalls.every((args) => args.every((arg) => arg !== 'default'))).toBe(true);
  });

  it('should keep the shutdown hooks free of a connection argument', async () => {
    // Given a single-connection service observing shutdown
    serviceName = uniqueServiceName();

    const created = await createTestApp(
      {
        name: serviceName,
        port,
        hooks: {
          [TransportEvent.ShutdownStart]: (...args: unknown[]) => hookCalls.push(args),
          [TransportEvent.ShutdownComplete]: (...args: unknown[]) => hookCalls.push(args),
        },
      },
      [GuardController],
    );

    // When it shuts down
    await created.app.close();

    // Then both hooks fired with no arguments at all
    expect(hookCalls).toEqual([[], []]);
  });

  it('should record metrics under the same names and labels', async () => {
    // Given a single-connection service with metrics enabled
    serviceName = uniqueServiceName();

    const register = new Registry();
    const created = await createTestApp(
      { name: serviceName, port, metrics: { register, pollInterval: 0 } },
      [GuardController],
      [serviceName],
    );

    app = created.app;

    // When a message is processed
    await firstValueFrom(
      app.get<ClientProxy>(getClientToken(serviceName)).emit('guard.event', { id: 1 }),
    );

    // Then the processed counter carries subject/kind/status and no connection label
    await waitForCondition(
      async () => /jetstream_messages_processed_total\{/.test(await register.metrics()),
      15_000,
    );

    const text = await register.metrics();
    const line = text.split('\n').find((l) => l.startsWith('jetstream_messages_processed_total{'));

    expect(line).toBeDefined();
    expect(line).not.toContain('connection=');
  });
});

describe('metrics keep working with several connections', () => {
  let primaryContainer: StartedTestContainer;
  let secondaryContainer: StartedTestContainer;
  let primaryPort: number;
  let secondaryPort: number;
  let app: INestApplication | undefined;

  beforeAll(async () => {
    const [primary, secondary] = await Promise.all([startNatsContainer(), startNatsContainer()]);

    primaryContainer = primary.container;
    primaryPort = primary.port;
    secondaryContainer = secondary.container;
    secondaryPort = secondary.port;
  });

  afterAll(async () => {
    await Promise.all([primaryContainer.stop(), secondaryContainer.stop()]);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('should aggregate across connections without breaking on the extra hook argument', async () => {
    // Given two connections and a shared metrics registry: subscribers now
    // receive a trailing connection name they were not written to expect
    const serviceName = uniqueServiceName();
    const register = new Registry();

    ({ app } = await createMultiConnectionApp({
      name: serviceName,
      root: { metrics: { register, pollInterval: 0 } },
      connections: {
        primary: { servers: [`nats://localhost:${primaryPort}`] },
        secondary: { servers: [`nats://localhost:${secondaryPort}`] },
      },
      defaultConnection: 'primary',
      controllers: [GuardController, SecondaryGuardController],
      clients: [{ name: serviceName }, { name: serviceName, connection: 'secondary' }],
    }));

    // When traffic flows on both connections
    await firstValueFrom(
      app.get<ClientProxy>(getClientToken(serviceName)).emit('guard.event', { id: 1 }),
    );
    await firstValueFrom(
      app
        .get<ClientProxy>(getClientToken(serviceName, 'secondary'))
        .emit('guard.secondary', { id: 2 }),
    );

    // Then both are counted, aggregated, and nothing throws
    await waitForCondition(async () => {
      const text = await register.metrics();

      return text.includes('guard.event') && text.includes('guard.secondary');
    }, 20_000);

    const text = await register.metrics();

    expect(text).toContain('guard.event');
    expect(text).toContain('guard.secondary');
  }, 60_000);
});
