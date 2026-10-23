import type { JetStreamManager } from '@nats-io/jetstream';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { JsonCodec } from '../../codec';
import type { ConnectionProvider } from '../../connection/connection.provider';
import { ServerCapabilities } from '../../connection/server-capabilities';
import type { ScheduleSpec } from '../../interfaces';
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
    // Given a spec only reachable from JavaScript or a widened type
    const spec = { everySeconds: 60, data: { a: 1 } } as ScheduleSpec;

    // When / Then
    await expect(sut.schedule('r-1', 'reminder.due', {}, spec)).rejects.toThrow(
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
