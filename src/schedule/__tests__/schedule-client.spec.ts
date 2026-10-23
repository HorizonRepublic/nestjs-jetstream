import type { JetStreamManager } from '@nats-io/jetstream';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { JsonCodec } from '../../codec';
import type { ConnectionProvider } from '../../connection/connection.provider';
import { ServerCapabilities } from '../../connection/server-capabilities';
import { SubjectResolver } from '../../server/infrastructure/subject-resolver';
import { ScheduleClient } from '../schedule-client';
import { ScheduleErrorReason } from '../schedule.types';

describe(ScheduleClient, () => {
  let connection: Mocked<ConnectionProvider>;
  let jsm: Mocked<JetStreamManager>;
  let level: number;
  let sut: ScheduleClient;

  beforeEach(() => {
    level = 5;
    jsm = createMock<JetStreamManager>();
    connection = createMock<ConnectionProvider>({
      getCapabilities: vi.fn(async () => new ServerCapabilities(level, 'n1 (NATS 2.15.1)')),
      getJetStreamManager: vi.fn().mockResolvedValue(jsm),
    });
    sut = new ScheduleClient(connection, new JsonCodec(), SubjectResolver.forService('asset', {}));
  });

  afterEach(vi.resetAllMocks);

  it.each(['', 'a.b', 'a*', 'a b'])('should refuse the id %j before any I/O', async (id) => {
    await expect(sut.schedule(id, 'reminder.due', {}, { everySeconds: 60 })).rejects.toThrow(
      expect.objectContaining({ reason: ScheduleErrorReason.InvalidId }),
    );
    expect(connection.getCapabilities).not.toHaveBeenCalled();
  });

  it('should refuse a wildcard pattern before any I/O', async () => {
    await expect(sut.schedule('r-1', 'reminder.*', {}, { everySeconds: 60 })).rejects.toThrow(
      expect.objectContaining({ reason: ScheduleErrorReason.InvalidPattern }),
    );
  });

  it('should refuse data inside the spec, which belongs in its own argument', async () => {
    // Given a spec only JavaScript can pass: the type rejects data inside it
    const pending = sut.schedule(
      'r-1',
      'reminder.due',
      {},
      {
        everySeconds: 60,
        // @ts-expect-error the payload belongs in its own argument
        data: { a: 1 },
      },
    );

    // When / Then
    await expect(pending).rejects.toThrow(
      expect.objectContaining({ reason: ScheduleErrorReason.InvalidData }),
    );
  });

  it('should refuse a recurring schedule on a server without them, before writing', async () => {
    // Given
    level = 3;

    // When / Then
    await expect(sut.schedule('r-1', 'reminder.due', {}, { everySeconds: 60 })).rejects.toThrow(
      /Schedule "r-1" needs NATS JetStream API level 4/,
    );
    expect(jsm.streams.find).not.toHaveBeenCalled();
  });

  it('should hold a one-shot to the older one-shot requirement', async () => {
    // Given NATS 2.11, which ignores schedules altogether
    level = 1;

    // When / Then
    await expect(
      sut.schedule('once', 'reminder.due', {}, { at: new Date(Date.now() + 60_000) }),
    ).rejects.toThrow(/Schedule "once" needs NATS JetStream API level 2/);
  });

  it('should refuse to cancel an invalid id', async () => {
    await expect(sut.cancelSchedule('a.b')).rejects.toThrow(
      expect.objectContaining({ reason: ScheduleErrorReason.InvalidId }),
    );
  });

  it('should explain a target that has no schedule stream', async () => {
    // Given
    vi.mocked(jsm.streams.find).mockRejectedValue(new Error('no stream matches subject'));

    // When / Then
    await expect(sut.listSchedules()).rejects.toThrow(
      /asset__microservice\.sched\..*schedule: true/,
    );
  });
});
