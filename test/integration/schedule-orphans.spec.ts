import { Controller, INestApplication } from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';

import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { internalName, StreamKind, streamName, toNanos } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class RemainingController {
  public ticks = 0;

  @EventPattern<string>('still.here', { schedule: true })
  stillHere(): void {
    this.ticks++;
  }
}

describe('Orphaned schedules', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;
  let app: INestApplication;
  let service: string;

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

  beforeEach(async () => {
    service = uniqueServiceName();
    ({ app } = await createTestApp(
      {
        name: service,
        port,
        schedule: { consumer: { max_deliver: 2, ack_wait: toNanos(1, 'seconds') } },
      },
      [RemainingController],
    ));
  });

  afterEach(async () => {
    await app.close();
    await cleanupStreams(nc, service);
  });

  const holderCount = async (subject: string): Promise<number> => {
    const jsm = await jetstreamManager(nc);
    const info = await jsm.streams.info(streamName(service, StreamKind.Schedule), {
      subjects_filter: subject,
    });

    return info.state.subjects?.[subject] ?? 0;
  };

  const schedule = async (holder: string, pattern: string): Promise<void> => {
    await jetstream(nc).publish(holder, new Uint8Array(), {
      schedule: { specification: '@every 1s', target: `${internalName(service)}.sched.${pattern}` },
    });
  };

  it('should cancel a schedule whose ticks no handler takes', async () => {
    // Given a schedule left behind by a handler that no longer exists
    const holder = `${internalName(service)}._cron.decl.removed.handler`;

    await schedule(holder, 'removed.handler');
    expect(await holderCount(holder)).toBe(1);

    // When its ticks exhaust their deliveries
    // Then the holder is gone
    await waitForCondition(async () => (await holderCount(holder)) === 0, 20_000, 250);
  }, 30_000);

  it('should keep a schedule a handler takes', async () => {
    // Given
    const holder = `${internalName(service)}._cron.dyn.kept`;
    const controller = app.get(RemainingController);

    await schedule(holder, 'still.here');

    // When
    await waitForCondition(() => controller.ticks >= 2, 10_000);

    // Then
    expect(await holderCount(holder)).toBe(1);
  }, 20_000);
});
