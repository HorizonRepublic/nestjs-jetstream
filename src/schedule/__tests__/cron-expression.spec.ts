import { afterEach, describe, expect, it, vi } from 'vitest';

import { nextFireTimes, parseCron } from '../cron-expression';
import { JetstreamScheduleError } from '../schedule-error';
import { ScheduleErrorReason } from '../schedule.types';

const next = (expression: string, from: string): string | undefined =>
  nextFireTimes(parseCron(expression), new Date(from), 1)[0]?.toISOString();

describe(parseCron, () => {
  afterEach(vi.resetAllMocks);

  describe('next fire time', () => {
    // Cases from robfig/cron spec_test.go TestNext, the parser NATS ports, read in UTC.
    it.each([
      ['0 0/15 * * * *', '2012-07-09T14:45:00Z', '2012-07-09T15:00:00.000Z'],
      ['0 0/15 * * * *', '2012-07-09T14:59:00Z', '2012-07-09T15:00:00.000Z'],
      ['0 0/15 * * * *', '2012-07-09T14:59:59Z', '2012-07-09T15:00:00.000Z'],
      ['0 20-35/15 * * * *', '2012-07-09T15:45:00Z', '2012-07-09T16:20:00.000Z'],
      ['0 */15 * * * *', '2012-07-09T23:46:00Z', '2012-07-10T00:00:00.000Z'],
      ['0 20-35/15 * * * *', '2012-07-09T23:45:00Z', '2012-07-10T00:20:00.000Z'],
      ['15/35 20-35/15 * * * *', '2012-07-09T23:35:51Z', '2012-07-10T00:20:15.000Z'],
      ['15/35 20-35/15 1/2 * * *', '2012-07-09T23:35:51Z', '2012-07-10T01:20:15.000Z'],
      ['15/35 20-35/15 10-12 * * *', '2012-07-09T23:35:51Z', '2012-07-10T10:20:15.000Z'],
      ['15/35 20-35/15 1/2 */2 * *', '2012-07-09T23:35:51Z', '2012-07-11T01:20:15.000Z'],
      ['15/35 20-35/15 * 9-20 * *', '2012-07-09T23:35:51Z', '2012-07-10T00:20:15.000Z'],
      ['15/35 20-35/15 * 9-20 Jul *', '2012-07-09T23:35:51Z', '2012-07-10T00:20:15.000Z'],
      ['0 0 0 9 Apr-Oct ?', '2012-07-09T23:35:00Z', '2012-08-09T00:00:00.000Z'],
      ['0 0 0 */5 Apr,Aug,Oct Mon', '2012-07-09T23:35:00Z', '2012-08-01T00:00:00.000Z'],
      ['0 0 0 */5 Oct Mon', '2012-07-09T23:35:00Z', '2012-10-01T00:00:00.000Z'],
      ['0 0 0 * Feb Mon', '2012-07-09T23:35:00Z', '2013-02-04T00:00:00.000Z'],
      ['0 0 0 * Feb Mon/2', '2012-07-09T23:35:00Z', '2013-02-01T00:00:00.000Z'],
      ['0 * * * * *', '2012-12-31T23:59:45Z', '2013-01-01T00:00:00.000Z'],
      ['0 0 0 29 Feb ?', '2012-07-09T23:35:00Z', '2016-02-29T00:00:00.000Z'],
    ])('should fire %s after %s at %s', (expression, from, expected) => {
      expect(next(expression, from)).toBe(expected);
    });

    it('should fire every other second for */2', () => {
      // Given
      const sut = parseCron('*/2 * * * * *');

      // When
      const fires = nextFireTimes(sut, new Date('2026-01-01T00:00:00Z'), 3);

      // Then
      expect(fires.map((d) => d.toISOString())).toEqual([
        '2026-01-01T00:00:02.000Z',
        '2026-01-01T00:00:04.000Z',
        '2026-01-01T00:00:06.000Z',
      ]);
    });

    it('should move a weekday schedule from Friday to Monday', () => {
      // Given Friday 10:00 UTC
      expect(next('0 0 9 * * mon-fri', '2026-10-23T10:00:00Z')).toBe('2026-10-26T09:00:00.000Z');
    });

    it('should fire when either day field matches if both are restricted', () => {
      // Friday 13 November 2026 and the next Friday or 13th after it
      expect(next('0 0 0 13 * 5', '2026-11-12T12:00:00Z')).toBe('2026-11-13T00:00:00.000Z');
      expect(next('0 0 0 13 * 5', '2026-11-13T12:00:00Z')).toBe('2026-11-20T00:00:00.000Z');
    });

    it('should require both day fields when one of them is a star', () => {
      expect(next('0 0 0 * * 0', '2012-07-09T00:00:00Z')).toBe('2012-07-15T00:00:00.000Z');
    });

    // Predefined patterns, as nats-server TestJetStreamScheduledMessageParse checks them.
    it.each([
      ['@yearly', '2028-01-01T00:00:00Z', '2029-01-01T00:00:00.000Z'],
      ['@annually', '2028-01-01T00:00:00Z', '2029-01-01T00:00:00.000Z'],
      ['@monthly', '2028-01-01T00:00:00Z', '2028-02-01T00:00:00.000Z'],
      ['@weekly', '2028-01-02T00:00:00Z', '2028-01-09T00:00:00.000Z'],
      ['@daily', '2028-01-01T00:00:00Z', '2028-01-02T00:00:00.000Z'],
      ['@midnight', '2028-01-01T00:00:00Z', '2028-01-02T00:00:00.000Z'],
      ['@hourly', '2028-01-01T00:00:00Z', '2028-01-01T01:00:00.000Z'],
    ])('should expand %s', (alias, from, expected) => {
      expect(next(alias, from)).toBe(expected);
    });

    it('should fire on the next second for six stars, even a nanosecond before it', () => {
      expect(next('* * * * * *', '2026-01-01T00:00:00.999Z')).toBe('2026-01-01T00:00:01.000Z');
    });

    it('should accept extra whitespace and empty list items like the server', () => {
      expect(next('0  0 9   * * 1,,3', '2026-10-23T10:00:00Z')).toBe('2026-10-26T09:00:00.000Z');
    });
  });

  describe('rejections', () => {
    it('should reject a field that matches nothing without searching five years', () => {
      // Given
      const started = performance.now();

      // When / Then
      expect(() => parseCron(', * * * * *')).toThrow(/matches no value/);
      expect(performance.now() - started).toBeLessThan(50);
    });

    it.each([
      ['five fields', '* * * * *'],
      ['seven fields', '* * * * * * *'],
      ['empty', ''],
      ['last day of month', '0 0 0 L * *'],
      ['nearest weekday', '0 0 0 1W * *'],
      ['nth weekday', '0 0 0 * * 1#2'],
      ['sunday as 7', '0 0 0 * * 7'],
      ['second out of range', '60 * * * * *'],
      ['hour out of range', '0 0 24 * * *'],
      ['day of month zero', '0 0 0 0 * *'],
      ['reversed range', '0 30-10 * * * *'],
      ['zero step', '0 */0 * * * *'],
      ['two hyphens', '0 1-2-3 * * * *'],
      ['two slashes', '0 */2/3 * * * *'],
      ['negative', '-1 * * * * *'],
      ['unknown name', '0 0 0 * Foo *'],
      ['never fires', '0 0 0 30 Feb ?'],
      ['only commas', '0 0 0 , * *'],
    ])('should reject %s', (_, expression) => {
      // When
      const act = (): unknown => parseCron(expression);

      // Then
      expect(act).toThrow(JetstreamScheduleError);
      expect(act).toThrow(expect.objectContaining({ reason: ScheduleErrorReason.InvalidCron }));
    });
  });
});
