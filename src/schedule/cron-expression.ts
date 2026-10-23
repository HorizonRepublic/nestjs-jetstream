import { JetstreamScheduleError } from './schedule-error';
import { ScheduleErrorReason } from './schedule.types';
import type { CronBounds, CronField, ParsedCron } from './schedule.types';

// A port of nats-server server/cron.go, itself derived from robfig/cron, so
// the client accepts exactly the expressions the server does.

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const SECONDS: CronBounds = { min: 0, max: 59 };
const MINUTES: CronBounds = { min: 0, max: 59 };
const HOURS: CronBounds = { min: 0, max: 23 };
const DAYS_OF_MONTH: CronBounds = { min: 1, max: 31 };
const MONTHS: CronBounds = { min: 1, max: 12, names: MONTH_NAMES };
const DAYS_OF_WEEK: CronBounds = { min: 0, max: 6, names: WEEKDAY_NAMES };

const ALIASES: Readonly<Record<string, string>> = {
  '@yearly': '0 0 0 1 1 *',
  '@annually': '0 0 0 1 1 *',
  '@monthly': '0 0 0 1 * *',
  '@weekly': '0 0 0 * * 0',
  '@daily': '0 0 0 * * *',
  '@midnight': '0 0 0 * * *',
  '@hourly': '0 0 * * * *',
};

const SEARCH_YEARS = 5;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

const invalid = (expression: string, detail: string): JetstreamScheduleError =>
  new JetstreamScheduleError(
    ScheduleErrorReason.InvalidCron,
    `Invalid cron expression "${expression}": ${detail}.`,
  );

const parseInteger = (text: string, expression: string): number => {
  if (!/^[+-]?\d+$/.test(text)) throw invalid(expression, `"${text}" is not a number`);

  const value = Number(text);

  if (value < 0) throw invalid(expression, `negative number ${value}`);

  return value;
};

const parseValue = (text: string, bounds: CronBounds, expression: string): number =>
  bounds.names?.[text.toLowerCase()] ?? parseInteger(text, expression);

interface RangeSpan {
  start: number;
  end: number;
  star: boolean;
}

/** The `*`, `?`, `n` or `a-b` part of a range item, before any step. */
const parseSpan = (text: string, bounds: CronBounds, expression: string): RangeSpan => {
  if (text === '*' || text === '?') return { start: bounds.min, end: bounds.max, star: true };

  const parts = text.split('-');

  if (parts.length > 2) throw invalid(expression, `too many hyphens in "${text}"`);

  const start = parseValue(parts[0] ?? '', bounds, expression);
  const end = parts.length === 2 ? parseValue(parts[1] ?? '', bounds, expression) : start;

  return { start, end, star: false };
};

const assertSpanInBounds = (
  span: RangeSpan,
  step: number,
  bounds: CronBounds,
  item: string,
  expression: string,
): void => {
  if (span.start < bounds.min)
    throw invalid(expression, `${span.start} is below ${bounds.min} in "${item}"`);
  if (span.end > bounds.max)
    throw invalid(expression, `${span.end} is above ${bounds.max} in "${item}"`);
  if (span.start > span.end) throw invalid(expression, `range starts after it ends in "${item}"`);
  if (step === 0) throw invalid(expression, `step must be positive in "${item}"`);
};

/** One comma-separated item: `*`, `?`, `n`, `a-b`, each optionally `/step`. Returns whether it was a star. */
const parseRange = (
  item: string,
  bounds: CronBounds,
  expression: string,
  into: Set<number>,
): boolean => {
  const rangeAndStep = item.split('/');

  if (rangeAndStep.length > 2) throw invalid(expression, `too many slashes in "${item}"`);

  const spanText = rangeAndStep[0] ?? '';
  const span = parseSpan(spanText, bounds, expression);
  const stepText = rangeAndStep[1];
  const step = stepText === undefined ? 1 : parseInteger(stepText, expression);

  if (stepText !== undefined) {
    // "N/step" means "N-max/step".
    if (!span.star && !spanText.includes('-')) span.end = bounds.max;
    if (step > 1) span.star = false;
  }

  assertSpanInBounds(span, step, bounds, item, expression);

  for (let value = span.start; value <= span.end; value += step) into.add(value);

  return span.star;
};

const parseField = (text: string, bounds: CronBounds, expression: string): CronField => {
  const values = new Set<number>();
  let star = false;

  for (const item of text.split(',')) {
    if (item.length > 0 && parseRange(item, bounds, expression, values)) star = true;
  }

  // Checked here: an empty set would otherwise cost the full five-year search to reject.
  if (values.size === 0) throw invalid(expression, `field "${text}" matches no value`);

  return { values, star };
};

const dayMatches = (cron: ParsedCron, t: Date): boolean => {
  const domMatch = cron.dayOfMonth.values.has(t.getUTCDate());
  const dowMatch = cron.dayOfWeek.values.has(t.getUTCDay());

  if (cron.dayOfMonth.star || cron.dayOfWeek.star) return domMatch && dowMatch;

  return domMatch || dowMatch;
};

const utc = (year: number, month: number, day: number, hour = 0, minute = 0): Date =>
  new Date(Date.UTC(year, month, day, hour, minute));

/** Where the search stands: the candidate time, and whether lower fields were already reset. */
interface SearchCursor {
  t: Date;
  truncated: boolean;
}

/** Advance one field until it matches; returns false when it rolled into the next larger unit. */
type FieldAdvance = (cron: ParsedCron, cursor: SearchCursor) => boolean;

const advanceMonth: FieldAdvance = (cron, cursor) => {
  while (!cron.month.values.has(cursor.t.getUTCMonth() + 1)) {
    const t = cursor.truncated
      ? cursor.t
      : utc(cursor.t.getUTCFullYear(), cursor.t.getUTCMonth(), 1);

    cursor.truncated = true;
    cursor.t = utc(t.getUTCFullYear(), t.getUTCMonth() + 1, 1);
    if (cursor.t.getUTCMonth() === 0) return false;
  }

  return true;
};

const advanceDay: FieldAdvance = (cron, cursor) => {
  while (!dayMatches(cron, cursor.t)) {
    const t = cursor.truncated
      ? cursor.t
      : utc(cursor.t.getUTCFullYear(), cursor.t.getUTCMonth(), cursor.t.getUTCDate());

    cursor.truncated = true;
    cursor.t = utc(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1);
    if (cursor.t.getUTCDate() === 1) return false;
  }

  return true;
};

/** Hours, minutes and seconds all advance by a fixed number of milliseconds. */
const fixedUnitAdvance =
  (
    field: (cron: ParsedCron) => CronField,
    read: (t: Date) => number,
    unitMs: number,
  ): FieldAdvance =>
  (cron, cursor) => {
    while (!field(cron).values.has(read(cursor.t))) {
      const t = cursor.truncated
        ? cursor.t
        : new Date(Math.floor(cursor.t.getTime() / unitMs) * unitMs);

      cursor.truncated = true;
      cursor.t = new Date(t.getTime() + unitMs);
      if (read(cursor.t) === 0) return false;
    }

    return true;
  };

const ADVANCES: readonly FieldAdvance[] = [
  advanceMonth,
  advanceDay,
  fixedUnitAdvance(
    (c) => c.hour,
    (t) => t.getUTCHours(),
    HOUR_MS,
  ),
  fixedUnitAdvance(
    (c) => c.minute,
    (t) => t.getUTCMinutes(),
    MINUTE_MS,
  ),
  fixedUnitAdvance(
    (c) => c.second,
    (t) => t.getUTCSeconds(),
    SECOND_MS,
  ),
];

/** The first fire strictly after `from`, or `null` within the server's five-year horizon. */
const nextAfter = (cron: ParsedCron, from: Date): Date | null => {
  const cursor: SearchCursor = {
    t: new Date(Math.floor(from.getTime() / SECOND_MS) * SECOND_MS + SECOND_MS),
    truncated: false,
  };
  const yearLimit = cursor.t.getUTCFullYear() + SEARCH_YEARS;

  while (cursor.t.getUTCFullYear() <= yearLimit) {
    // A field that rolls over invalidates the larger ones, so start again from the month.
    if (ADVANCES.every((advance) => advance(cron, cursor))) return cursor.t;
  }

  return null;
};

/**
 * Parse a NATS cron expression: six fields `sec min hour dom month dow`, or an alias.
 *
 * @throws JetstreamScheduleError with `InvalidCron` for anything the server would reject,
 *   including an expression that never fires within five years.
 */
export const parseCron = (expression: string): ParsedCron => {
  const expanded = ALIASES[expression] ?? expression;
  const fields = expanded.split(/\s+/).filter((field) => field.length > 0);

  if (fields.length !== 6) {
    throw invalid(
      expression,
      `expected 6 fields (sec min hour dom month dow), got ${fields.length}`,
    );
  }

  const [second = '', minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = fields;
  const parsed: ParsedCron = {
    expression,
    second: parseField(second, SECONDS, expression),
    minute: parseField(minute, MINUTES, expression),
    hour: parseField(hour, HOURS, expression),
    dayOfMonth: parseField(dayOfMonth, DAYS_OF_MONTH, expression),
    month: parseField(month, MONTHS, expression),
    dayOfWeek: parseField(dayOfWeek, DAYS_OF_WEEK, expression),
  };

  if (nextAfter(parsed, new Date()) === null) {
    throw invalid(expression, `it never fires within ${SEARCH_YEARS} years`);
  }

  return parsed;
};

/**
 * The next `count` fire times after `from`, in UTC.
 *
 * @throws JetstreamScheduleError when the expression stops firing within five years of a fire.
 */
export const nextFireTimes = (cron: ParsedCron, from: Date, count: number): Date[] => {
  const fires: Date[] = [];
  let cursor = from;

  while (fires.length < count) {
    const fire = nextAfter(cron, cursor);

    if (fire === null)
      throw invalid(cron.expression, `it never fires within ${SEARCH_YEARS} years`);

    fires.push(fire);
    cursor = fire;
  }

  return fires;
};
