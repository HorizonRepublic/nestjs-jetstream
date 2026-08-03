import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JETSTREAM_CONNECTIONS, JetstreamConnection } from '../../src';
import type { ConnectionRegistry } from '../../src/connection/connection-registry';
import { createMultiConnectionApp, uniqueServiceName } from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class PrimaryController {
  @EventPattern('shutdown.primary')
  public onPrimary(@Payload() _data: unknown): void {}
}

@JetstreamConnection('analytics')
@Controller()
class AnalyticsController {
  @EventPattern('shutdown.analytics')
  public onAnalytics(@Payload() _data: unknown): void {}
}

describe('multi-connection shutdown', () => {
  let primaryContainer: StartedTestContainer;
  let analyticsContainer: StartedTestContainer;
  let primaryPort: number;
  let analyticsPort: number;

  beforeAll(async () => {
    const [primary, analytics] = await Promise.all([startNatsContainer(), startNatsContainer()]);

    primaryContainer = primary.container;
    primaryPort = primary.port;
    analyticsContainer = analytics.container;
    analyticsPort = analytics.port;
  });

  afterAll(async () => {
    await Promise.all([primaryContainer.stop(), analyticsContainer.stop()]);
  });

  it('should close every connection, not just the default one', async () => {
    // Given an application consuming from two clusters
    const { app } = await createMultiConnectionApp({
      name: uniqueServiceName(),
      connections: {
        primary: { servers: [`nats://localhost:${primaryPort}`] },
        analytics: { servers: [`nats://localhost:${analyticsPort}`] },
      },
      defaultConnection: 'primary',
      controllers: [PrimaryController, AnalyticsController],
    });

    const registry = app.get<ConnectionRegistry>(JETSTREAM_CONNECTIONS, { strict: false });

    expect(registry.all().every((scope) => scope.connection.unwrap !== null)).toBe(true);

    // When the application shuts down
    await app.close();

    // Then no connection is left open — a sequential drain used to reach only the default
    for (const scope of registry.all()) {
      expect(scope.connection.unwrap).toBeNull();
    }
  }, 60_000);

  it('should not let one connection consume another connection budget', async () => {
    // Given a per-connection budget far below the root one
    const { app } = await createMultiConnectionApp({
      name: uniqueServiceName(),
      root: { shutdownTimeout: 30_000 },
      connections: {
        primary: { servers: [`nats://localhost:${primaryPort}`], shutdownTimeout: 2_000 },
        analytics: { servers: [`nats://localhost:${analyticsPort}`], shutdownTimeout: 2_000 },
      },
      defaultConnection: 'primary',
      controllers: [PrimaryController, AnalyticsController],
    });

    // When the application shuts down
    const startedAt = Date.now();

    await app.close();

    // Then the ceiling is max(budgets), not their sum, and well under the root budget
    expect(Date.now() - startedAt).toBeLessThan(6_000);
  }, 60_000);
});
