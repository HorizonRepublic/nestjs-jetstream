import { coversOrEquals } from '../server/infrastructure/subject-utils';
import type { DeadLetterFilter, DeadLetterRecord } from './dlq.types';

const reasonMatches = (reason: string, expected: string | RegExp): boolean =>
  typeof expected === 'string' ? reason.includes(expected) : expected.test(reason);

const withinWindow = (failedAt: Date | undefined, filter: DeadLetterFilter): boolean => {
  if (filter.failedAfter === undefined && filter.failedBefore === undefined) return true;
  if (failedAt === undefined) return false;
  if (filter.failedAfter !== undefined && failedAt < filter.failedAfter) return false;

  return filter.failedBefore === undefined || failedAt <= filter.failedBefore;
};

/** Whether a dead letter meets every criterion the filter sets. */
export const matchesDeadLetter = (record: DeadLetterRecord, filter: DeadLetterFilter): boolean => {
  if (filter.subject !== undefined && !coversOrEquals(filter.subject, record.subject)) return false;
  if (filter.pattern !== undefined && record.pattern !== filter.pattern) return false;
  if (filter.reason !== undefined && !reasonMatches(record.reason, filter.reason)) return false;
  if (filter.fromSeq !== undefined && record.seq < filter.fromSeq) return false;
  if (filter.toSeq !== undefined && record.seq > filter.toSeq) return false;

  return withinWindow(record.failedAt, filter);
};
