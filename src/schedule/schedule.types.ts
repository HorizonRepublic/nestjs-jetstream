import type { JetStreamPublishOptions } from '@nats-io/jetstream';

import type { ScheduleInfo } from '../interfaces';

/** Why a schedule was refused. */
export enum ScheduleErrorReason {
  InvalidCron = 'invalid-cron',
  InvalidAt = 'invalid-at',
  InvalidInterval = 'invalid-interval',
  InvalidTtl = 'invalid-ttl',
  InvalidTimezone = 'invalid-timezone',
  InvalidId = 'invalid-id',
  InvalidPattern = 'invalid-pattern',
  InvalidData = 'invalid-data',
  /** The server has no time zone data for a zone the client accepted. */
  ServerTimezoneData = 'server-timezone-data',
  ServerRejected = 'server-rejected',
  UnsupportedServer = 'unsupported-server',
}

/** One cron field: which values match, and whether it was written as a star. */
export interface CronField {
  readonly values: ReadonlySet<number>;
  readonly star: boolean;
}

/** A parsed six-field cron expression. */
export interface ParsedCron {
  readonly expression: string;
  readonly second: CronField;
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

/** The accepted range of one cron field and its value names. */
export interface CronBounds {
  readonly min: number;
  readonly max: number;
  readonly names?: Readonly<Record<string, number>>;
}

/** A holder ready to publish, with the hash of the definition it carries. */
export interface HolderMessage {
  readonly subject: string;
  readonly payload: Uint8Array;
  readonly options: Partial<JetStreamPublishOptions>;
  readonly hash: string;
}

/** A holder as the stream stores it. */
export interface StoredHolder {
  readonly subject: string;
  readonly seq: number;
  readonly hash: string;
  readonly info: ScheduleInfo;
}

/** What a compare-and-set write did. */
export enum PutOutcome {
  Written = 'written',
  /** The holder changed since it was read; read again before retrying. */
  Conflict = 'conflict',
}
