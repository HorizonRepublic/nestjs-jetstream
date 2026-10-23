import { JetStreamApiError } from '@nats-io/jetstream';
import type { StoredMsg } from '@nats-io/jetstream';

import type { ConnectionProvider } from '../connection/connection.provider';
import { ScheduleOrigin } from '../interfaces';
import { NatsErrorCode } from '../server/infrastructure/nats-error-codes';
import { JetstreamScheduleError } from './schedule-error';
import { readHolder } from './schedule-holder';
import { PutOutcome, ScheduleErrorReason } from './schedule.types';
import type { HolderMessage, StoredHolder } from './schedule.types';

const CONFLICT_CODES: ReadonlySet<number> = new Set([
  NatsErrorCode.StreamWrongLastSequence,
  NatsErrorCode.StreamWrongLastSequenceConstant,
]);

const REJECTION_CODES: ReadonlySet<number> = new Set([
  NatsErrorCode.MessageSchedulesDisabled,
  NatsErrorCode.MessageSchedulesPatternInvalid,
  NatsErrorCode.MessageSchedulesTargetInvalid,
]);

const errorCodeOf = (err: unknown): number | undefined =>
  err instanceof JetStreamApiError ? err.apiError().err_code : undefined;

const translatePublishError = (err: unknown, holder: HolderMessage): unknown => {
  const code = errorCodeOf(err);

  if (code === NatsErrorCode.MessageSchedulesTimeZoneInvalid) {
    return new JetstreamScheduleError(
      ScheduleErrorReason.ServerTimezoneData,
      `The NATS server rejected the time zone of ${holder.subject}. The official scratch images ` +
        'carry no time zone data; run an alpine image, or schedule in UTC.',
      { cause: err },
    );
  }

  if (code !== undefined && REJECTION_CODES.has(code)) {
    return new JetstreamScheduleError(
      ScheduleErrorReason.ServerRejected,
      `The NATS server rejected the schedule ${holder.subject}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  return err;
};

/** Schedule holders of one schedule stream: read, written with compare-and-set, cancelled. */
export class ScheduleStore {
  public constructor(
    private readonly connection: ConnectionProvider,
    private readonly streamName: string,
    private readonly holderPrefix: string,
  ) {}

  /** Every holder, or those of one origin. */
  public async list(origin?: ScheduleOrigin): Promise<StoredHolder[]> {
    const jsm = await this.connection.getJetStreamManager();
    const filter = `${this.holderPrefix}${origin === undefined ? '' : `${origin}.`}>`;
    const info = await jsm.streams.info(this.streamName, { subjects_filter: filter });
    const subjects = Object.keys(info.state.subjects ?? {}).toSorted();
    const holders = await Promise.all(subjects.map(async (subject) => this.read(subject)));

    return holders.filter((holder): holder is StoredHolder => holder !== null);
  }

  /** The holder stored on `subject`, or `null` when there is none or another tool wrote it. */
  public async read(subject: string): Promise<StoredHolder | null> {
    const msg = await this.lastOn(subject);

    return msg === null ? null : readHolder(msg, this.holderPrefix);
  }

  /** When the message on `subject` was stored, whoever wrote it, or `null` when there is none. */
  public async writtenAt(subject: string): Promise<Date | null> {
    return (await this.lastOn(subject))?.time ?? null;
  }

  /**
   * Write a holder only if its subject is still at `expectedLastSeq` (0: absent).
   *
   * @throws JetstreamScheduleError when the server refuses the schedule itself.
   */
  public async put(holder: HolderMessage, expectedLastSeq: number): Promise<PutOutcome> {
    await this.connection.getConnection();

    try {
      await this.connection.getJetStreamClient().publish(holder.subject, holder.payload, {
        ...holder.options,
        expect: { lastSubjectSequence: expectedLastSeq },
      });

      return PutOutcome.Written;
    } catch (err) {
      const code = errorCodeOf(err);

      if (code !== undefined && CONFLICT_CODES.has(code)) return PutOutcome.Conflict;
      if (code === NatsErrorCode.StreamExpectedLastSeqPerSubjectNotReady) {
        return PutOutcome.Unavailable;
      }

      throw translatePublishError(err, holder);
    }
  }

  private async lastOn(subject: string): Promise<StoredMsg | null> {
    const jsm = await this.connection.getJetStreamManager();

    return jsm.streams.getMessage(this.streamName, { last_by_subj: subject });
  }

  /** Remove the holder on exactly `subject`; nothing happens when there is none. */
  public async cancel(subject: string): Promise<void> {
    const jsm = await this.connection.getJetStreamManager();

    await jsm.streams.purge(this.streamName, { filter: subject });
  }
}
