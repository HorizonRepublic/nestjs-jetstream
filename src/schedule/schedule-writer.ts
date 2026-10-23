import { ScheduleChange } from '../interfaces';
import type { Codec, ScheduleSpec } from '../interfaces';
import { buildHolder } from './schedule-holder';
import type { ScheduleStore } from './schedule-store';
import { PutOutcome } from './schedule.types';

/** One retry after a conflict: enough for a replica that raced us, not a fight. */
const MAX_ATTEMPTS = 2;

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

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const current = await this.store.read(holderSubject);

      if (current?.hash === holder.hash) return ScheduleChange.Unchanged;

      const outcome = await this.store.put(holder, current?.seq ?? 0);

      if (outcome === PutOutcome.Written) {
        return current === null ? ScheduleChange.Created : ScheduleChange.Updated;
      }
    }

    const settled = await this.store.read(holderSubject);

    if (settled?.hash === holder.hash) return ScheduleChange.Unchanged;

    throw new Error(
      `Schedule ${holderSubject} kept changing while it was written; another writer holds a ` +
        'different definition. Check that every replica runs the same schedule.',
    );
  }
}
