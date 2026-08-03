import { Controller } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { JetstreamConnection, JetstreamHealthIndicator } from '../../src';
import { createMultiConnectionApp, uniqueServiceName } from './helpers';
import { startNatsContainer } from './nats-container';

const received: string[] = [];

/** A port nothing listens on, so the connection attempt fails fast. */
const DEAD_PORT = 14_931;

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

  it('should fail startup when a critical connection is unreachable', async () => {
    // Given a second connection that is critical by default
    // When the app is bootstrapped, Then it rejects rather than starting degraded
    await expect(
      createMultiConnectionApp({
        name: uniqueServiceName(),
        connections: {
          primary: { servers: [`nats://localhost:${port}`] },
          audit: {
            servers: [`nats://localhost:${DEAD_PORT + 1}`],
            connectionOptions: { maxReconnectAttempts: 1, timeout: 500 },
          },
        },
        defaultConnection: 'primary',
        controllers: [],
      }),
    ).rejects.toThrow();
  });
});
