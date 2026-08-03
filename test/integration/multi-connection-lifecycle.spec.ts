import { Controller } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { ClientProxy } from '@nestjs/microservices';

import { jetstream } from '@nats-io/jetstream';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildSubject,
  getClientToken,
  JetstreamConnection,
  JetstreamHealthIndicator,
  StreamKind,
} from '../../src';
import {
  createMultiConnectionApp,
  createNatsConnection,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer, startNatsContainerWithFixedPort } from './nats-container';

const received: string[] = [];

/** A port nothing listens on, so the connection attempt fails fast. */
const DEAD_PORT = 14_931;

/** Bound later in the recovery test, so it must be free until then. */
const LATE_PORT = 14_932;

/** A second dead port: must not collide with LATE_PORT, which gets a container. */
const OTHER_DEAD_PORT = 14_933;

@JetstreamConnection('analytics')
@Controller()
class AnalyticsController {
  @EventPattern('page.viewed')
  public onView(@Payload() data: { id: string }): void {
    received.push(data.id);
  }
}

describe('multi-connection lifecycle', () => {
  let container: StartedTestContainer;
  let port: number;
  let app: INestApplication | undefined;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
  });

  afterAll(async () => {
    await container.stop();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    received.length = 0;
  });

  it('should start when a non-critical connection is unreachable', async () => {
    // Given a non-critical connection pointing at a closed port
    ({ app } = await createMultiConnectionApp({
      name: uniqueServiceName(),
      connections: {
        primary: { servers: [`nats://localhost:${port}`] },
        analytics: {
          servers: [`nats://localhost:${DEAD_PORT}`],
          critical: false,
          connectionOptions: { maxReconnectAttempts: 1, timeout: 500 },
        },
      },
      defaultConnection: 'primary',
      controllers: [AnalyticsController],
    }));

    // When health is checked
    const status = await app.get(JetstreamHealthIndicator).check();

    // Then readiness holds and the status is degraded
    expect(status.connected).toBe(true);
    expect(status.degraded).toBe(true);
    expect(status.connections?.analytics?.connected).toBe(false);
    expect(status.connections?.analytics?.critical).toBe(false);
    expect(status.connections?.primary?.connected).toBe(true);
  });

  it('should attach consumers once a non-critical cluster comes up after boot', async () => {
    // Given a service that started while its analytics cluster was down
    const serviceName = uniqueServiceName();

    ({ app } = await createMultiConnectionApp({
      name: serviceName,
      connections: {
        primary: { servers: [`nats://localhost:${port}`] },
        analytics: {
          servers: [`nats://localhost:${LATE_PORT}`],
          critical: false,
          connectionOptions: { maxReconnectAttempts: -1, reconnectTimeWait: 250, timeout: 500 },
        },
      },
      defaultConnection: 'primary',
      controllers: [AnalyticsController],
    }));

    expect((await app.get(JetstreamHealthIndicator).check()).degraded).toBe(true);

    // When the cluster finally comes up on the port the service was configured with
    const late = await startNatsContainerWithFixedPort(LATE_PORT);

    try {
      // Then the background retry attaches the consumer and health recovers
      await waitForCondition(
        async () => (await app!.get(JetstreamHealthIndicator).check()).degraded === false,
        90_000,
        500,
      );

      const nc = await createNatsConnection(LATE_PORT);
      const client = jetstream(nc);

      await client.publish(
        buildSubject(serviceName, StreamKind.Event, 'page.viewed'),
        JSON.stringify({ id: 'late' }),
      );

      await waitForCondition(() => received.includes('late'), 30_000);
      expect(received).toContain('late');

      await nc.drain();
    } finally {
      await late.container.stop();
    }
  }, 180_000);

  it('should report a meaningful error when emitting into a dead non-critical connection', async () => {
    // Given a non-critical connection that never came up
    const serviceName = uniqueServiceName();

    ({ app } = await createMultiConnectionApp({
      name: serviceName,
      connections: {
        primary: { servers: [`nats://localhost:${port}`] },
        analytics: {
          servers: [`nats://localhost:${DEAD_PORT}`],
          critical: false,
          connectionOptions: { maxReconnectAttempts: 1, timeout: 500 },
        },
      },
      defaultConnection: 'primary',
      clients: [{ name: serviceName, connection: 'analytics' }],
    }));

    // When a publish is attempted on it
    const client = app.get<ClientProxy>(getClientToken(serviceName, 'analytics'));

    // Then it rejects rather than hanging forever
    await expect(firstValueFrom(client.emit('page.viewed', { id: 'x' }))).rejects.toThrow();
  }, 60_000);

  it('should shut down cleanly when a connection never connected', async () => {
    // Given a running app whose non-critical connection is still down
    const serviceName = uniqueServiceName();
    const created = await createMultiConnectionApp({
      name: serviceName,
      connections: {
        primary: { servers: [`nats://localhost:${port}`] },
        analytics: {
          servers: [`nats://localhost:${DEAD_PORT}`],
          critical: false,
          shutdownTimeout: 2_000,
          connectionOptions: { maxReconnectAttempts: 1, timeout: 500 },
        },
      },
      defaultConnection: 'primary',
      controllers: [AnalyticsController],
    });

    // When it shuts down
    const startedAt = Date.now();

    await expect(created.app.close()).resolves.toBeUndefined();

    // Then the never-connected connection does not stall the drain
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 60_000);

  it('should fail startup when a critical connection is unreachable', async () => {
    // Given a second connection that is critical by default
    // When the app is bootstrapped, Then it rejects rather than starting degraded
    await expect(
      createMultiConnectionApp({
        name: uniqueServiceName(),
        connections: {
          primary: { servers: [`nats://localhost:${port}`] },
          audit: {
            servers: [`nats://localhost:${OTHER_DEAD_PORT}`],
            connectionOptions: { maxReconnectAttempts: 1, timeout: 500 },
          },
        },
        defaultConnection: 'primary',
        controllers: [],
      }),
    ).rejects.toThrow();
  });
});
