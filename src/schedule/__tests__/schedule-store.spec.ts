import { JetStreamApiError } from '@nats-io/jetstream';
import type { JetStreamClient } from '@nats-io/jetstream';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonCodec } from '../../codec';
import type { ConnectionProvider } from '../../connection/connection.provider';
import { buildHolder } from '../schedule-holder';
import { ScheduleStore } from '../schedule-store';
import { PutOutcome } from '../schedule.types';

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

  it.each([10071, 10164])('should report error %i as a conflict', async (code) => {
    await expect(putWith(apiError(code))).resolves.toBe(PutOutcome.Conflict);
  });

  it('should report a momentarily unknown subject sequence as unavailable', async () => {
    await expect(putWith(apiError(10163))).resolves.toBe(PutOutcome.Unavailable);
  });
});
