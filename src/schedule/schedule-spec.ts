import type { CronSchedule, ScheduleSpec } from '../interfaces';
import { nextFireTimes, parseCron } from './cron-expression';
import { JetstreamScheduleError } from './schedule-error';
import { ScheduleErrorReason } from './schedule.types';

const TTL_SAMPLE_FIRES = 10;
const MAX_DEFAULT_TTL_SECONDS = 365 * 24 * 60 * 60;
const SECOND_MS = 1000;

const isPositiveWholeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/** Narrow a spec to its cron form. */
export const isCronSchedule = (spec: ScheduleSpec): spec is CronSchedule => 'cron' in spec;

const assertTimezone = (timezone: string): void => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new JetstreamScheduleError(
      ScheduleErrorReason.InvalidTimezone,
      `Unknown time zone "${timezone}". Use an IANA name such as "Europe/Kyiv", or "UTC".`,
    );
  }
};

/**
 * Check a schedule against the rules the NATS server enforces, before anything is sent.
 *
 * @throws JetstreamScheduleError naming the first rule the spec breaks.
 */
export const validateScheduleSpec = (spec: ScheduleSpec): void => {
  if (spec.ttlSeconds !== undefined && !isPositiveWholeNumber(spec.ttlSeconds)) {
    throw new JetstreamScheduleError(
      ScheduleErrorReason.InvalidTtl,
      `ttlSeconds must be a positive whole number of seconds; got ${String(spec.ttlSeconds)}.`,
    );
  }

  if (isCronSchedule(spec)) {
    parseCron(spec.cron);
    if (spec.timezone !== undefined) assertTimezone(spec.timezone);

    return;
  }

  if ('timezone' in spec) {
    throw new JetstreamScheduleError(
      ScheduleErrorReason.InvalidTimezone,
      'A time zone applies to cron schedules only; NATS refuses it on an interval.',
    );
  }

  if (!isPositiveWholeNumber(spec.everySeconds)) {
    throw new JetstreamScheduleError(
      ScheduleErrorReason.InvalidInterval,
      `everySeconds must be a positive whole number; got ${String(spec.everySeconds)}. ` +
        'NATS schedules have one-second resolution and round fractions up.',
    );
  }
};

/** The schedule as the `Nats-Schedule` header carries it. */
export const toNatsSpecification = (spec: ScheduleSpec): string =>
  isCronSchedule(spec) ? spec.cron : `@every ${spec.everySeconds}s`;

/**
 * How long a tick may wait unconsumed: the explicit `ttlSeconds`, else the
 * interval, else the shortest gap between a cron's next fires (capped at a
 * year), so a service that was down finds one tick, not a backlog.
 */
export const resolveTickTtlSeconds = (spec: ScheduleSpec, now: Date): number => {
  if (spec.ttlSeconds !== undefined) return spec.ttlSeconds;
  if (!isCronSchedule(spec)) return spec.everySeconds;

  const fires = nextFireTimes(parseCron(spec.cron), now, TTL_SAMPLE_FIRES);
  let shortest = MAX_DEFAULT_TTL_SECONDS;

  for (let i = 1; i < fires.length; i++) {
    const gap = ((fires[i]?.getTime() ?? 0) - (fires[i - 1]?.getTime() ?? 0)) / SECOND_MS;

    shortest = Math.min(shortest, gap);
  }

  return shortest;
};

/**
 * Require a single NATS subject token: no dots, wildcards or whitespace.
 *
 * @throws JetstreamScheduleError with the given reason.
 */
export const assertSubjectToken = (value: string, reason: ScheduleErrorReason): void => {
  if (value.length === 0 || /[.*>\s]/.test(value)) {
    throw new JetstreamScheduleError(
      reason,
      `"${value}" must be one subject token: non-empty, without ".", "*", ">" or whitespace.`,
    );
  }
};
