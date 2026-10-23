import { Controller, INestApplication } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';

import type { NatsConnection } from '@nats-io/transport-node';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  getClientToken,
  JetstreamClient,
  JetstreamModule,
  ScheduleChange,
  ScheduleOrigin,
} from '../../src';
import type { JetstreamModuleOptions, TargetSubjectPrefixes } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class ReminderController {
  public readonly received: unknown[] = [];

  @EventPattern('reminder.due', { schedule: true })
  due(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

const sleep = async (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Schedules from a client', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;
  const apps: INestApplication[] = [];
  const services: string[] = [];

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
    await Promise.all(services.splice(0).map(async (s) => cleanupStreams(nc, s)));
  });

  const setup = async (
    targetOptions: Partial<JetstreamModuleOptions> = {},
    subjectPrefix?: TargetSubjectPrefixes,
  ): Promise<{ client: JetstreamClient; target: ReminderController }> => {
    const target = uniqueServiceName();
    const caller = uniqueServiceName();

    services.push(target, caller);

    const { app } = await createTestApp({ name: target, port, ...targetOptions }, [
      ReminderController,
    ]);

    apps.push(app);

    const module = await Test.createTestingModule({
      imports: [
        JetstreamModule.forRoot({
          name: caller,
          servers: [`nats://localhost:${port}`],
          publisherOnly: true,
        }),
        JetstreamModule.forFeature({ name: target, ...(subjectPrefix ? { subjectPrefix } : {}) }),
      ],
    }).compile();
    const callerApp = module.createNestApplication({ logger: false });

    await callerApp.init();
    apps.push(callerApp);

    return {
      client: callerApp.get<JetstreamClient>(getClientToken(target)),
      target: app.get(ReminderController),
    };
  };

  it('should run, list, keep and cancel an interval schedule', async () => {
    // Given
    const { client, target } = await setup();

    // When
    const created = await client.schedule(
      'reminder-42',
      'reminder.due',
      { id: 42 },
      {
        everySeconds: 1,
      },
    );

    // Then it fires with its payload
    expect(created).toBe(ScheduleChange.Created);
    await waitForCondition(() => target.received.length >= 2, 10_000);
    expect(target.received[0]).toEqual({ id: 42 });

    // And it is listed as a dynamic schedule, and repeating it changes nothing
    expect(await client.listSchedules()).toEqual([
      {
        id: 'reminder-42',
        origin: ScheduleOrigin.Dynamic,
        pattern: 'reminder.due',
        specification: '@every 1s',
        ttlSeconds: 1,
      },
    ]);
    expect(
      await client.schedule('reminder-42', 'reminder.due', { id: 42 }, { everySeconds: 1 }),
    ).toBe(ScheduleChange.Unchanged);

    // When cancelled, it stops
    await client.cancelSchedule('reminder-42');
    await sleep(1_500);

    const settled = target.received.length;

    await sleep(2_500);
    expect(target.received.length).toBe(settled);
    expect(await client.listSchedules()).toEqual([]);
  }, 30_000);

  it('should fire a one-shot schedule once', async () => {
    // Given
    const { client, target } = await setup();

    // When
    await client.schedule('once', 'reminder.due', 'hello', { at: new Date(Date.now() + 1_500) });

    // Then
    await waitForCondition(() => target.received.length === 1, 10_000);
    await sleep(2_000);
    expect(target.received).toEqual(['hello']);
    expect(await client.listSchedules()).toEqual([]);
  }, 20_000);

  it('should reach a target that consumes schedules on a custom prefix', async () => {
    // Given
    const prefix = `acme.${uniqueServiceName()}.cron`;
    const { client, target } = await setup(
      { schedule: { subjectPrefix: prefix } },
      {
        schedule: prefix,
      },
    );

    // When
    await client.schedule('custom', 'reminder.due', 'x', { everySeconds: 1 });

    // Then
    await waitForCondition(() => target.received.length >= 1, 10_000);
    expect(await client.listSchedules()).toHaveLength(1);
  }, 20_000);
});
