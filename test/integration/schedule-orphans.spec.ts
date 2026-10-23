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

const sleep = async (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  const boot = async (): Promise<void> => {
    ({ app } = await createTestApp(
      {
        name: service,
        port,
        schedule: { consumer: { max_deliver: 2, ack_wait: toNanos(1, 'seconds') } },
      },
      [RemainingController],
    ));
  };

  beforeEach(() => {
    service = uniqueServiceName();
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

  it('should cancel a schedule older than the replica whose ticks no handler takes', async () => {
    // Given a schedule left by a previous release, written before this replica started
    await boot();
    await app.close();

    const holder = `${internalName(service)}._cron.decl.removed.handler`;

    await schedule(holder, 'removed.handler');
    await sleep(11_000);
    await boot();

    // When its ticks exhaust their deliveries
    // Then the holder is gone
    await waitForCondition(async () => (await holderCount(holder)) === 0, 20_000, 250);
    expect(await holderCount(holder)).toBe(0);
  }, 45_000);

  it('should leave a schedule newer than the replica to the replicas that handle it', async () => {
    // Given a replica without the handler, and a schedule a newer replica just wrote
    await boot();

    const holder = `${internalName(service)}._cron.dyn.from-a-newer-release`;

    await schedule(holder, 'added.in.next.release');

    // When its ticks exhaust their deliveries on this replica
    await sleep(6_000);

    // Then the schedule survives
    expect(await holderCount(holder)).toBe(1);
  }, 20_000);

  it('should keep a schedule a handler takes', async () => {
    // Given
    await boot();

    const holder = `${internalName(service)}._cron.dyn.kept`;
    const controller = app.get(RemainingController);

    await schedule(holder, 'still.here');

    // When
    await waitForCondition(() => controller.ticks >= 2, 10_000);

    // Then
    expect(await holderCount(holder)).toBe(1);
  }, 20_000);
});
