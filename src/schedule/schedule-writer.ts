import { ScheduleChange } from '../interfaces';
import type { Codec, ScheduleSpec } from '../interfaces';
import { JetstreamScheduleError } from './schedule-error';
import { buildHolder } from './schedule-holder';
import type { ScheduleStore } from './schedule-store';
import { PutOutcome, ScheduleErrorReason } from './schedule.types';

/** One retry after a conflict: enough for a replica that raced us, not a fight. */
const MAX_ATTEMPTS = 2;

/** Waits while the stream cannot check sequences, as during a leader change. */
const UNAVAILABLE_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000];

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Writes a schedule only when its definition changed.
 *
 * Republishing an unchanged `everySeconds` schedule would reset its phase, so
 * a replica that boots every few seconds would keep the schedule from ever
 * firing. Comparing hashes first keeps the holder, and its phase, untouched.
 */
export class ScheduleWriter {
  public constructor(
    private readonly store: ScheduleStore,
    private readonly codec: Codec,
  ) {}

  public async upsert(
    holderSubject: string,
    target: string,
    pattern: string,
    spec: ScheduleSpec,
    now: Date,
  ): Promise<ScheduleChange> {
    const holder = buildHolder(
      holderSubject,
      target,
      pattern,
      spec,
      this.codec.encode(spec.data),
      now,
    );

    let conflicts = 0;
    let waits = 0;

    while (conflicts < MAX_ATTEMPTS) {
      const current = await this.store.read(holderSubject);

      if (current?.hash === holder.hash) return ScheduleChange.Unchanged;

      const outcome = await this.store.put(holder, current?.seq ?? 0);

      if (outcome === PutOutcome.Written) {
        return current === null ? ScheduleChange.Created : ScheduleChange.Updated;
      }

      if (outcome === PutOutcome.Conflict) {
        conflicts++;
      } else if (waits < UNAVAILABLE_DELAYS_MS.length) {
        await sleep(UNAVAILABLE_DELAYS_MS[waits++] ?? 0);
      } else {
        throw new JetstreamScheduleError(
          ScheduleErrorReason.LeaderChange,
          `Schedule ${holderSubject} could not be written: the stream kept reporting its ` +
            'sequences as unavailable, which happens briefly during a leader change.',
        );
      }
    }

    const settled = await this.store.read(holderSubject);

    if (settled?.hash === holder.hash) return ScheduleChange.Unchanged;

    throw new JetstreamScheduleError(
      ScheduleErrorReason.ConcurrentWriter,
      `Schedule ${holderSubject} kept changing while it was written; another writer holds a ` +
        'different definition. Check that every replica runs the same schedule.',
    );
  }
}
