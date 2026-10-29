import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { JsonCodec } from '../../codec';
import { ScheduleChange, ScheduleOrigin } from '../../interfaces';
import type { ScheduleSpec } from '../../interfaces';
import { buildHolder } from '../schedule-holder';
import { ScheduleStore } from '../schedule-store';
import { ScheduleWriter } from '../schedule-writer';
import { PutOutcome } from '../schedule.types';
import type { StoredHolder } from '../schedule.types';
import { ScheduleErrorReason } from '../schedule.types';

const NOW = new Date('2026-10-23T12:00:00Z');
const SUBJECT = 'svc__microservice._cron.decl.sync.tick';
const TARGET = 'svc__microservice.sched.sync.tick';
const SPEC: ScheduleSpec = { everySeconds: 60 };

const storedWith = (spec: ScheduleSpec, seq: number): StoredHolder => ({
  subject: SUBJECT,
  seq,
  writtenAt: NOW,
  hash: buildHolder(SUBJECT, TARGET, 'sync.tick', spec, new JsonCodec().encode(undefined), NOW)
    .hash,
  info: {
    id: 'sync.tick',
    origin: ScheduleOrigin.Declared,
    pattern: 'sync.tick',
    specification: '',
  },
});

describe(ScheduleWriter, () => {
  let store: Mocked<ScheduleStore>;
  let sut: ScheduleWriter;

  beforeEach(() => {
    store = createMock<ScheduleStore>({
      read: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(PutOutcome.Written),
    });
    sut = new ScheduleWriter(store, new JsonCodec());
  });

  afterEach(vi.resetAllMocks);

  it('should create a schedule that does not exist yet', async () => {
    // When
    const change = await sut.upsert(SUBJECT, TARGET, 'sync.tick', SPEC, NOW);

    // Then
    expect(change).toBe(ScheduleChange.Created);
    expect(store.put).toHaveBeenCalledWith(expect.objectContaining({ subject: SUBJECT }), 0);
  });

  it('should leave an unchanged schedule alone, keeping its phase', async () => {
    // Given
    store.read.mockResolvedValue(storedWith(SPEC, 5));

    // When
    const change = await sut.upsert(SUBJECT, TARGET, 'sync.tick', SPEC, NOW);

    // Then
    expect(change).toBe(ScheduleChange.Unchanged);
    expect(store.put).not.toHaveBeenCalled();
  });

  it('should update a changed schedule against the sequence it read', async () => {
    // Given
    store.read.mockResolvedValue(storedWith({ everySeconds: 30 }, 5));

    // When
    const change = await sut.upsert(SUBJECT, TARGET, 'sync.tick', SPEC, NOW);

    // Then
    expect(change).toBe(ScheduleChange.Updated);
    expect(store.put).toHaveBeenCalledWith(expect.anything(), 5);
  });

  it('should accept a concurrent writer that wrote the same definition', async () => {
    // Given another replica creates it between our read and write
    store.read.mockResolvedValueOnce(null).mockResolvedValueOnce(storedWith(SPEC, 1));
    store.put.mockResolvedValueOnce(PutOutcome.Conflict);

    // When
    const change = await sut.upsert(SUBJECT, TARGET, 'sync.tick', SPEC, NOW);

    // Then
    expect(change).toBe(ScheduleChange.Unchanged);
    expect(store.put).toHaveBeenCalledOnce();
  });

  it('should retry once when a concurrent writer wrote something else', async () => {
    // Given
    store.read
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(storedWith({ everySeconds: 30 }, 1));
    store.put.mockResolvedValueOnce(PutOutcome.Conflict).mockResolvedValueOnce(PutOutcome.Written);

    // When
    const change = await sut.upsert(SUBJECT, TARGET, 'sync.tick', SPEC, NOW);

    // Then
    expect(change).toBe(ScheduleChange.Updated);
    expect(store.put).toHaveBeenLastCalledWith(expect.anything(), 1);
  });

  it('should wait out a stream that briefly cannot check sequences', async () => {
    // Given a leader change right after the write was first attempted
    vi.useFakeTimers();
    store.put
      .mockResolvedValueOnce(PutOutcome.Unavailable)
      .mockResolvedValueOnce(PutOutcome.Unavailable)
      .mockResolvedValueOnce(PutOutcome.Written);

    // When
    const pending = sut.upsert(SUBJECT, TARGET, 'sync.tick', SPEC, NOW);

    await vi.runAllTimersAsync();

    // Then
    await expect(pending).resolves.toBe(ScheduleChange.Created);
    expect(store.put).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('should give up when the stream stays unable to check sequences', async () => {
    // Given
    vi.useFakeTimers();
    store.put.mockResolvedValue(PutOutcome.Unavailable);

    // When
    const failure = sut.upsert(SUBJECT, TARGET, 'sync.tick', SPEC, NOW).then(
      () => null,
      (err: unknown) => err,
    );

    await vi.runAllTimersAsync();

    // Then
    expect(await failure).toEqual(
      expect.objectContaining({
        name: 'JetstreamScheduleError',
        reason: ScheduleErrorReason.LeaderChange,
        message: expect.stringMatching(/sequences as unavailable/),
      }),
    );
    vi.useRealTimers();
  });

  it('should give up when the holder keeps changing under it', async () => {
    // Given
    store.read.mockResolvedValue(storedWith({ everySeconds: 30 }, 1));
    store.put.mockResolvedValue(PutOutcome.Conflict);

    // When / Then
    await expect(sut.upsert(SUBJECT, TARGET, 'sync.tick', SPEC, NOW)).rejects.toThrow(
      expect.objectContaining({
        name: 'JetstreamScheduleError',
        reason: ScheduleErrorReason.ConcurrentWriter,
        message: expect.stringMatching(/kept changing/),
      }),
    );
  });
});
