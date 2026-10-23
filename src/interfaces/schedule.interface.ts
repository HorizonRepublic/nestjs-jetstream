/** Predefined cron schedules NATS accepts in place of a six-field expression. */
export type CronAlias =
  | '@yearly'
  | '@annually'
  | '@monthly'
  | '@weekly'
  | '@daily'
  | '@midnight'
  | '@hourly';

/**
 * A NATS cron expression: six fields, `sec min hour dom month dow`, or an alias.
 *
 * The type catches a missing seconds field in a literal. Ranges, names and
 * steps are checked at runtime against the same grammar the server uses.
 */
export type CronExpression =
  | CronAlias
  | `${string} ${string} ${string} ${string} ${string} ${string}`;

/** A schedule that fires on a cron expression. */
export interface CronSchedule {
  cron: CronExpression;

  /** IANA zone the expression is read in. Default `UTC`. */
  timezone?: string;

  /**
   * How long an unconsumed tick stays in the stream, in whole seconds.
   * Defaults to the shortest gap between the next fires.
   */
  ttlSeconds?: number;

  /** Payload every tick carries, encoded with the connection codec. */
  data?: unknown;
}

/** A schedule that fires every `everySeconds` seconds. */
export interface IntervalSchedule {
  /** Whole seconds, at least 1. NATS has one-second resolution. */
  everySeconds: number;

  /** How long an unconsumed tick stays in the stream, in whole seconds. Defaults to the interval. */
  ttlSeconds?: number;

  /** Payload every tick carries, encoded with the connection codec. */
  data?: unknown;
}

/**
 * A schedule that fires once, at `at`. For delays longer than the events
 * stream keeps messages, which `scheduleAt()` cannot outlive. Client API only.
 */
export interface AtSchedule {
  at: Date;

  /** How long the tick stays in the stream unconsumed, in whole seconds. Default: no limit. */
  ttlSeconds?: number;

  /** Payload the tick carries, encoded with the connection codec. */
  data?: unknown;
}

/** When a schedule fires. */
export type ScheduleSpec = CronSchedule | IntervalSchedule | AtSchedule;

/** The schedules a handler may declare: recurring ones only. */
export type RecurringScheduleSpec = CronSchedule | IntervalSchedule;

/**
 * The `schedule` extra of `@EventPattern`: a spec the handler owns, or `true`
 * for a handler that only receives schedules created through a client.
 */
export type ScheduleHandlerOption = RecurringScheduleSpec | true;

/** Who owns a schedule. */
export enum ScheduleOrigin {
  /** Declared on a handler and reconciled at boot. */
  Declared = 'decl',
  /** Created through `JetstreamClient.schedule()`. */
  Dynamic = 'dyn',
}

/** What writing a schedule did. */
export enum ScheduleChange {
  Created = 'created',
  Updated = 'updated',
  /** The stored schedule already matched; nothing was written. */
  Unchanged = 'unchanged',
}

/** A stored schedule as `listSchedules()` reports it. */
export interface ScheduleInfo {
  /** The handler pattern for a declared schedule, the caller's id for a dynamic one. */
  id: string;
  origin: ScheduleOrigin;
  /** Pattern the ticks are delivered to. */
  pattern: string;
  /** The schedule as NATS stores it, such as `@every 600s` or `0 0 9 * * mon-fri`. */
  specification: string;
  timezone?: string;
  ttlSeconds?: number;
}
