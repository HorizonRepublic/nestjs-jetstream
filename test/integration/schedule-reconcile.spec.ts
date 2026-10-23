import { Controller, INestApplication } from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';

import { jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { internalName, StreamKind, streamName } from '../../src';
import type { ScheduleHandlerOption } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

interface TickCounter {
  ticks: number;
}

/** A controller class whose tick handler declares `schedule`; one class per spec. */
const tickController = (schedule: ScheduleHandlerOption): new () => TickCounter => {
  @Controller()
  class TickController {
    public ticks = 0;

    @EventPattern<string>('sync.tick', { schedule })
    tick(): void {
      this.ticks++;
    }
  }

  return TickController;
};

describe('Schedule reconcile', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;
  const apps: INestApplication[] = [];
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

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
    await cleanupStreams(nc, service);
  });

  const boot = async (schedule: ScheduleHandlerOption): Promise<INestApplication> => {
    const { app } = await createTestApp({ name: service, port }, [tickController(schedule)]);

    apps.push(app);

    return app;
  };

  const bootCounting = async (schedule: ScheduleHandlerOption): Promise<TickCounter> => {
    const Counter = tickController(schedule);
    const { app } = await createTestApp({ name: service, port }, [Counter]);

    apps.push(app);

    return app.get(Counter);
  };

  const holder = async (): Promise<{ seq: number; spec: string }> => {
    const jsm = await jetstreamManager(nc);
    const msg = await jsm.streams.getMessage(streamName(service, StreamKind.Schedule), {
      last_by_subj: `${internalName(service)}._cron.decl.sync.tick`,
    });

    return { seq: msg?.seq ?? 0, spec: msg?.header.get('Nats-Schedule') ?? '' };
  };

  it('should fire an interval schedule a handler declares', async () => {
    // Given
    service = uniqueServiceName();

    const controller = await bootCounting({ everySeconds: 1 });

    // Then
    await waitForCondition(() => controller.ticks >= 3, 6_000);
    expect(controller.ticks).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it('should leave the holder alone when another replica boots with the same schedule', async () => {
    // Given
    service = uniqueServiceName();
    await Promise.all([boot({ everySeconds: 60 }), boot({ everySeconds: 60 })]);

    const first = await holder();

    // When a third replica boots
    await boot({ everySeconds: 60 });

    // Then nothing was republished
    expect(await holder()).toEqual(first);
    expect(first.spec).toBe('@every 60s');
  });

  it('should update the holder when the schedule changes', async () => {
    // Given
    service = uniqueServiceName();

    const old = await boot({ everySeconds: 60 });

    await old.close();
    apps.splice(apps.indexOf(old), 1);

    // When
    await boot({ cron: '0 0 9 * * *' });

    // Then
    expect((await holder()).spec).toBe('0 0 9 * * *');
  });
});

describe('Schedule reconcile on NATS 2.12', () => {
  it('should refuse to start, naming the requirement', async () => {
    // Given
    const { container, port } = await startNatsContainer('nats:2.12.6');
    const service = uniqueServiceName();

    try {
      // When / Then
      await expect(
        createTestApp({ name: service, port }, [tickController({ everySeconds: 60 })]),
      ).rejects.toThrow(/Handler "sync.tick" needs NATS JetStream API level 4/);
    } finally {
      await container.stop();
    }
  });
});
