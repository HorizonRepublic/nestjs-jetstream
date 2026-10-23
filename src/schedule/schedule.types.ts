/** Why a schedule was refused. */
export enum ScheduleErrorReason {
  InvalidCron = 'invalid-cron',
  InvalidInterval = 'invalid-interval',
  InvalidTtl = 'invalid-ttl',
  InvalidTimezone = 'invalid-timezone',
  InvalidId = 'invalid-id',
  InvalidPattern = 'invalid-pattern',
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
