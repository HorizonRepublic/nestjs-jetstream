import { Controller, Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';

import type { StartedTestContainer } from 'testcontainers';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { dlqStreamName, StreamKind, streamName } from '../../src';
import { createTestApp, uniqueServiceName } from './helpers';
import { startNatsCluster, startNatsContainer, type NatsClusterResult } from './nats-container';

@Controller()
class OrdersController {
  @EventPattern<string>('order.created')
  public handleOrder(): void {}
}

const singleReplicaWarnings = (spy: MockInstance<Logger['warn']>): string[] =>
  spy.mock.calls
    .map((args: unknown[]) => String(args[0]))
    .filter((m: string) => m.includes('single replica'));

describe('Single replica warning on a clustered NATS', () => {
  let cluster: NatsClusterResult | undefined;
  let app: INestApplication | undefined;

  beforeAll(async () => {
    cluster = await startNatsCluster({ nodes: 3 });
  }, 180_000);

  afterAll(async () => {
    await cluster?.stop();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it('should name every stream left at the default single replica', async () => {
    // Given
    const serviceName = uniqueServiceName();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');

    // When
    ({ app } = await createTestApp({ name: serviceName, port: cluster!.port }, [OrdersController]));

    // Then
    const warnings = singleReplicaWarnings(warnSpy);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(streamName(serviceName, StreamKind.Event));
    expect(warnings[0]).toContain(dlqStreamName(serviceName));
  }, 60_000);

  it('should stay quiet once every stream sets its replicas', async () => {
    // Given
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');

    // When
    ({ app } = await createTestApp(
      {
        name: uniqueServiceName(),
        port: cluster!.port,
        events: { stream: { num_replicas: 3 } },
        dlq: { stream: { num_replicas: 1 } },
      },
      [OrdersController],
    ));

    // Then
    expect(singleReplicaWarnings(warnSpy)).toEqual([]);
  }, 60_000);
});

describe('Single replica warning on a single NATS server', () => {
  let container: StartedTestContainer;
  let port: number;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
  });

  afterAll(async () => {
    await container.stop();
  });

  it('should not warn without clustering', async () => {
    // Given
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');

    // When
    const { app } = await createTestApp({ name: uniqueServiceName(), port }, [OrdersController]);

    try {
      // Then
      expect(singleReplicaWarnings(warnSpy)).toEqual([]);
    } finally {
      await app.close();
      vi.restoreAllMocks();
    }
  });
});
