import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';

import { jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { dlqStreamName, getClientToken } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

/** A service with no handlers provisions nothing, so the DLQ cases need one. */
@Controller()
class QuietController {
  @EventPattern('order.quiet')
  public handle(@Payload() _data: unknown): void {
    // nothing to do; the handler exists so the service provisions its streams
  }
}

/** Records when each delivery landed so the gap between them can be measured. */
@Controller()
class AlwaysFailingController {
  public readonly attemptsAt: number[] = [];

  @EventPattern('order.failing')
  public handle(@Payload() _data: unknown): void {
    this.attemptsAt.push(Date.now());
    throw new Error('always fails');
  }
}

describe('Retry pacing and DLQ defaults', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
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

  it('should space redeliveries by the configured curve', async () => {
    // Given a handler that always throws and a deliberately slow curve
    serviceName = uniqueServiceName();

    const created = await createTestApp(
      {
        name: serviceName,
        port,
        events: { consumer: { max_deliver: 3 }, retry: [1_000, 2_000] },
      },
      [AlwaysFailingController],
      [serviceName],
    );

    app = created.app;
    const sut = created.module.get(AlwaysFailingController);
    const client = created.module.get<ClientProxy>(getClientToken(serviceName));

    // When the message is published and burns through its attempts
    await firstValueFrom(client.emit('order.failing', { id: 1 }));
    await waitForCondition(() => sut.attemptsAt.length >= 3, 20_000);

    // Then the gaps follow the curve rather than firing back to back
    const firstGap = sut.attemptsAt[1]! - sut.attemptsAt[0]!;
    const secondGap = sut.attemptsAt[2]! - sut.attemptsAt[1]!;

    expect(firstGap).toBeGreaterThanOrEqual(800);
    expect(secondGap).toBeGreaterThanOrEqual(1_800);
  });

  it('should provision a dead-letter stream without being asked', async () => {
    // Given a service configured with nothing but a name and servers
    serviceName = uniqueServiceName();

    const created = await createTestApp(
      { name: serviceName, port },
      [QuietController],
      [serviceName],
    );

    app = created.app;

    // When the DLQ stream is looked up
    const jsm = await jetstreamManager(nc);
    const info = await jsm.streams.info(dlqStreamName(serviceName));

    // Then it exists, sized for dead letters rather than for throughput
    expect(info.config.name).toBe(dlqStreamName(serviceName));
    expect(info.config.max_bytes).toBe(256 * 1024 * 1024);
  });

  it('should provision no dead-letter stream when it is turned off', async () => {
    // Given the DLQ explicitly disabled
    serviceName = uniqueServiceName();

    const created = await createTestApp(
      { name: serviceName, port, dlq: false },
      [QuietController],
      [serviceName],
    );

    app = created.app;

    // When the DLQ stream is looked up / Then it was never created
    const jsm = await jetstreamManager(nc);

    await expect(jsm.streams.info(dlqStreamName(serviceName))).rejects.toThrow(/not found/i);
  });
});
