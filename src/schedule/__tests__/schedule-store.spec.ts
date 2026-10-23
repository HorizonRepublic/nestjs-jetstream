import { JetStreamApiError } from '@nats-io/jetstream';
import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonCodec } from '../../codec';
import type { ConnectionProvider } from '../../connection/connection.provider';
import { buildHolder } from '../schedule-holder';
import { ScheduleStore } from '../schedule-store';
import { PutOutcome, ScheduleErrorReason } from '../schedule.types';

const apiError = (err_code: number): JetStreamApiError =>
  new JetStreamApiError({ err_code, code: 400, description: 'rejected' });

describe(ScheduleStore, () => {
  afterEach(vi.resetAllMocks);

  const putWith = async (error: Error): Promise<PutOutcome> => {
    const js = createMock<JetStreamClient>({ publish: vi.fn().mockRejectedValue(error) });
    const connection = createMock<ConnectionProvider>({ getJetStreamClient: vi.fn(() => js) });
    const sut = new ScheduleStore(connection, 'stream', 'svc._cron.');
    const holder = buildHolder(
      'svc._cron.dyn.a',
      'svc.sched.a',
      'a',
      { everySeconds: 1 },
      new JsonCodec().encode(undefined),
      new Date(),
    );

    return sut.put(holder, 0);
  };

  it('should read a long list of holders in bounded batches', async () => {
    // Given 200 holders
    const subjects = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`svc._cron.dyn.r-${i}`, 1]),
    );
    let inFlight = 0;
    let peak = 0;
    const jsm = createMock<JetStreamManager>({
      streams: {
        info: vi.fn().mockResolvedValue({ state: { subjects } }),
        getMessage: vi.fn(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setImmediate(resolve));
          inFlight--;

          return null;
        }),
      },
    });
    const connection = createMock<ConnectionProvider>({
      getJetStreamManager: vi.fn().mockResolvedValue(jsm),
    });

    // When
    await new ScheduleStore(connection, 'stream', 'svc._cron.').list();

    // Then
    expect(jsm.streams.getMessage).toHaveBeenCalledTimes(200);
    expect(peak).toBeLessThanOrEqual(32);
  });

  it.each([10071, 10164])('should report error %i as a conflict', async (code) => {
    await expect(putWith(apiError(code))).resolves.toBe(PutOutcome.Conflict);
  });

  it('should explain a schedule TTL the stream cannot honour', async () => {
    await expect(putWith(apiError(10191))).rejects.toThrow(
      expect.objectContaining({ reason: ScheduleErrorReason.ServerRejected }),
    );
  });

  it('should pass any other failure through untouched', async () => {
    // Given
    const failure = new Error('connection closed');

    // When / Then
    await expect(putWith(failure)).rejects.toBe(failure);
  });

  it('should report a momentarily unknown subject sequence as unavailable', async () => {
    await expect(putWith(apiError(10163))).resolves.toBe(PutOutcome.Unavailable);
  });
});
