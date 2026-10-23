import { jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { createMock } from '@golevelup/ts-vitest';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ScheduleOrigin } from '../../src';
import { ConnectionProvider } from '../../src/connection/connection.provider';
import { EventBus } from '../../src/hooks';
import { DEFAULT_SCHEDULE_STREAM_CONFIG } from '../../src/jetstream.constants';
import { buildHolder } from '../../src/schedule/schedule-holder';
import { ScheduleStore } from '../../src/schedule/schedule-store';
import { PutOutcome, ScheduleErrorReason } from '../../src/schedule/schedule.types';
import type { HolderMessage } from '../../src/schedule/schedule.types';
import { createNatsConnection, uniqueServiceName } from './helpers';
import { startNatsContainer } from './nats-container';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('ScheduleStore', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;
  let connection: ConnectionProvider;
  let sut: ScheduleStore;
  let stream: string;
  let prefix: string;
  let ticks: string;

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
    const service = uniqueServiceName();

    stream = `${service}_sched`;
    prefix = `${service}._cron.`;
    ticks = `${service}.sched.`;

    const jsm = await jetstreamManager(nc);

    await jsm.streams.add({
      ...DEFAULT_SCHEDULE_STREAM_CONFIG,
      name: stream,
      subjects: [`${ticks}>`, `${prefix}>`],
    });

    connection = new ConnectionProvider(
      { name: service, servers: [`nats://localhost:${port}`] },
      createMock<EventBus>(),
    );
    sut = new ScheduleStore(connection, stream, prefix);
  });

  afterEach(async () => {
    await connection.shutdown();
    await (await jetstreamManager(nc)).streams.delete(stream);
  });

  const holder = (
    id: string,
    everySeconds: number,
    origin = ScheduleOrigin.Dynamic,
  ): HolderMessage =>
    buildHolder(
      `${prefix}${origin}.${id}`,
      `${ticks}reminder.due`,
      'reminder.due',
      { everySeconds },
      encode('{}'),
      new Date(),
    );

  it('should create only when nothing exists, and report a lost race as a conflict', async () => {
    // When
    const first = await sut.put(holder('r-1', 60), 0);
    const second = await sut.put(holder('r-1', 60), 0);

    // Then
    expect(first).toBe(PutOutcome.Written);
    expect(second).toBe(PutOutcome.Conflict);
  });

  it('should update against the sequence it read', async () => {
    // Given
    await sut.put(holder('r-1', 60), 0);

    const current = await sut.read(`${prefix}dyn.r-1`);

    // When
    const outcome = await sut.put(holder('r-1', 120), current?.seq ?? -1);

    // Then
    expect(outcome).toBe(PutOutcome.Written);
    expect((await sut.read(`${prefix}dyn.r-1`))?.info.specification).toBe('@every 120s');
  });

  it('should list holders of both origins with their decoded definitions', async () => {
    // Given
    await sut.put(holder('sync.tick', 600, ScheduleOrigin.Declared), 0);
    await sut.put(holder('r-1', 60), 0);

    // When
    const all = await sut.list();
    const declared = await sut.list(ScheduleOrigin.Declared);

    // Then
    expect(all.map((h) => h.info.id).toSorted()).toEqual(['r-1', 'sync.tick']);
    expect(declared.map((h) => h.info)).toEqual([
      {
        id: 'sync.tick',
        origin: ScheduleOrigin.Declared,
        pattern: 'reminder.due',
        specification: '@every 600s',
        ttlSeconds: 600,
      },
    ]);
  });

  it('should cancel one holder without touching a longer id that shares its prefix', async () => {
    // Given
    await sut.put(holder('reminder-4', 60), 0);
    await sut.put(holder('reminder-42', 60), 0);

    // When
    await sut.cancel(`${prefix}dyn.reminder-4`);
    await sut.cancel(`${prefix}dyn.unknown`);

    // Then
    expect((await sut.list()).map((h) => h.info.id)).toEqual(['reminder-42']);
  });

  it('should explain a time zone the server image has no data for', async () => {
    // Given the official scratch image, which ships no tzdata
    const zoned = buildHolder(
      `${prefix}dyn.z`,
      `${ticks}reminder.due`,
      'reminder.due',
      { cron: '0 0 9 * * *', timezone: 'Europe/Kyiv' },
      encode('{}'),
      new Date(),
    );

    // When / Then
    await expect(sut.put(zoned, 0)).rejects.toThrow(
      expect.objectContaining({ reason: ScheduleErrorReason.ServerTimezoneData }),
    );
  });
});
