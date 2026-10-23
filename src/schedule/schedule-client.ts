import type { ConnectionProvider } from '../connection/connection.provider';
import { NatsCapability } from '../connection/server-capabilities.types';
import { ScheduleOrigin, StreamKind } from '../interfaces';
import type { Codec, ScheduleChange, ScheduleInfo, ScheduleSpec } from '../interfaces';
import type { SubjectResolver } from '../server/infrastructure/subject-resolver';
import { JetstreamScheduleError } from './schedule-error';
import {
  assertLiteralSubject,
  assertSubjectToken,
  isAtSchedule,
  validateScheduleSpec,
} from './schedule-spec';
import { ScheduleStore } from './schedule-store';
import { ScheduleWriter } from './schedule-writer';
import { ScheduleErrorReason } from './schedule.types';

/** A literal subject inside the target's tick namespace, used only to find its stream. */
const LOOKUP_TOKEN = 'schedule-lookup';

/**
 * Dynamic schedules on one target service: create or replace, cancel, list.
 * The target's schedule stream is found by subject, so a custom stream name works.
 */
export class ScheduleClient {
  private storePromise: Promise<ScheduleStore> | null = null;

  public constructor(
    private readonly connection: ConnectionProvider,
    private readonly codec: Codec,
    private readonly subjects: SubjectResolver,
  ) {}

  public async schedule(
    id: string,
    pattern: string,
    data: unknown,
    spec: ScheduleSpec,
  ): Promise<ScheduleChange> {
    assertSubjectToken(id, ScheduleErrorReason.InvalidId);
    assertLiteralSubject(pattern, ScheduleErrorReason.InvalidPattern);

    if (spec.data !== undefined) {
      throw new JetstreamScheduleError(
        ScheduleErrorReason.InvalidData,
        `Schedule "${id}": pass the payload as the data argument, not inside the spec.`,
      );
    }

    validateScheduleSpec(spec);

    (await this.connection.getCapabilities()).assert(
      isAtSchedule(spec) ? NatsCapability.MessageSchedules : NatsCapability.RecurringSchedules,
      `Schedule "${id}"`,
    );

    const writer = new ScheduleWriter(await this.store(), this.codec);

    return writer.upsert(
      this.holderSubject(id),
      this.subjects.subject(StreamKind.Schedule, pattern),
      pattern,
      { ...spec, data },
      new Date(),
    );
  }

  /** Cancel a dynamic schedule; nothing happens when it does not exist. */
  public async cancelSchedule(id: string): Promise<void> {
    assertSubjectToken(id, ScheduleErrorReason.InvalidId);

    await (await this.store()).cancel(this.holderSubject(id));
  }

  /** Every schedule of the target, declared and dynamic. */
  public async listSchedules(): Promise<ScheduleInfo[]> {
    return (await (await this.store()).list()).map((holder) => holder.info);
  }

  private holderSubject(id: string): string {
    return `${this.subjects.schedulePrefix(StreamKind.Schedule)}${ScheduleOrigin.Dynamic}.${id}`;
  }

  private async store(): Promise<ScheduleStore> {
    this.storePromise ??= this.findStore().catch((err: unknown) => {
      this.storePromise = null;
      throw err;
    });

    return this.storePromise;
  }

  private async findStore(): Promise<ScheduleStore> {
    const tickSubject = this.subjects.subject(StreamKind.Schedule, LOOKUP_TOKEN);
    const jsm = await this.connection.getJetStreamManager();
    let stream: string;

    try {
      stream = await jsm.streams.find(tickSubject);
    } catch (err) {
      throw new Error(
        `No schedule stream captures ${tickSubject}. The target service creates it when one of ` +
          'its handlers declares `schedule: true` or a schedule in @EventPattern extras.',
        { cause: err },
      );
    }

    return new ScheduleStore(
      this.connection,
      stream,
      this.subjects.schedulePrefix(StreamKind.Schedule),
    );
  }
}
