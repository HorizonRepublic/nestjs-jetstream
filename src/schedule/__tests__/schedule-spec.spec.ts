import { faker } from '@faker-js/faker';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScheduleSpec } from '../../interfaces';
import { JetstreamScheduleError } from '../schedule-error';
import {
  assertSubjectToken,
  isCronSchedule,
  resolveTickTtlSeconds,
  toNatsSpecification,
  validateScheduleSpec,
} from '../schedule-spec';
import { ScheduleErrorReason } from '../schedule.types';

const reasonOf = (act: () => void): ScheduleErrorReason | undefined => {
  try {
    act();
  } catch (error) {
    if (error instanceof JetstreamScheduleError) return error.reason;
    throw error;
  }

  return undefined;
};

const FRIDAY_NOON = new Date('2026-10-23T12:00:00Z');

describe('schedule spec', () => {
  afterEach(vi.resetAllMocks);

  describe(toNatsSpecification, () => {
    it('should write an interval as whole seconds', () => {
      expect(toNatsSpecification({ everySeconds: 600 })).toBe('@every 600s');
    });

    it('should write a one-shot time in RFC 3339', () => {
      expect(toNatsSpecification({ at: new Date('2027-01-01T09:00:00Z') })).toBe(
        '@at 2027-01-01T09:00:00.000Z',
      );
    });

    it('should pass a cron expression through', () => {
      expect(toNatsSpecification({ cron: '0 */10 * * * *' })).toBe('0 */10 * * * *');
    });
  });

  describe(resolveTickTtlSeconds, () => {
    it('should leave a one-shot without a ttl unless one is given', () => {
      expect(resolveTickTtlSeconds({ at: new Date('2027-01-01T00:00:00Z') }, FRIDAY_NOON)).toBe(
        undefined,
      );
      expect(
        resolveTickTtlSeconds(
          { at: new Date('2027-01-01T00:00:00Z'), ttlSeconds: 60 },
          FRIDAY_NOON,
        ),
      ).toBe(60);
    });

    it('should default an interval to the interval', () => {
      expect(resolveTickTtlSeconds({ everySeconds: 600 }, FRIDAY_NOON)).toBe(600);
    });

    it('should prefer an explicit ttl', () => {
      expect(resolveTickTtlSeconds({ everySeconds: 600, ttlSeconds: 30 }, FRIDAY_NOON)).toBe(30);
    });

    it('should default a cron to the shortest gap between its next fires', () => {
      expect(resolveTickTtlSeconds({ cron: '0 0 9 * * mon-fri' }, FRIDAY_NOON)).toBe(86_400);
    });

    it('should cap a rare cron at one year', () => {
      expect(resolveTickTtlSeconds({ cron: '@yearly' }, FRIDAY_NOON)).toBeLessThanOrEqual(
        31_536_000,
      );
      expect(resolveTickTtlSeconds({ cron: '@yearly' }, FRIDAY_NOON)).toBeGreaterThan(0);
    });
  });

  describe(validateScheduleSpec, () => {
    it.each<ScheduleSpec>([
      { everySeconds: 1 },
      { everySeconds: 86_400, ttlSeconds: 60 },
      { cron: '0 */10 * * * *', timezone: 'Europe/Kyiv', ttlSeconds: 600 },
      { cron: '@daily' },
    ])('should accept %j', (spec) => {
      expect(() => {
        validateScheduleSpec(spec);
      }).not.toThrow();
    });

    it('should accept a one-shot in the future', () => {
      expect(() => {
        validateScheduleSpec({ at: new Date(Date.now() + 60_000) });
      }).not.toThrow();
    });

    it.each([new Date(Date.now() - 1_000), new Date(Number.NaN)])(
      'should reject the one-shot time %s',
      (at) => {
        expect(
          reasonOf(() => {
            validateScheduleSpec({ at });
          }),
        ).toBe(ScheduleErrorReason.InvalidAt);
      },
    );

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'should reject everySeconds %s',
      (everySeconds) => {
        expect(
          reasonOf(() => {
            validateScheduleSpec({ everySeconds });
          }),
        ).toBe(ScheduleErrorReason.InvalidInterval);
      },
    );

    it.each([0, 1.5, -5])('should reject ttlSeconds %s', (ttlSeconds) => {
      expect(
        reasonOf(() => {
          validateScheduleSpec({ everySeconds: 10, ttlSeconds });
        }),
      ).toBe(ScheduleErrorReason.InvalidTtl);
    });

    it('should reject a time zone on an interval, which the server refuses', () => {
      // Given a spec only reachable from JavaScript
      const spec = { everySeconds: 10, timezone: 'Europe/Kyiv' } as unknown as ScheduleSpec;

      // When / Then
      expect(
        reasonOf(() => {
          validateScheduleSpec(spec);
        }),
      ).toBe(ScheduleErrorReason.InvalidTimezone);
    });

    it('should accept an interval whose optional time zone is undefined', () => {
      expect(() => {
        validateScheduleSpec({ everySeconds: 10, timezone: undefined } as unknown as ScheduleSpec);
      }).not.toThrow();
    });

    it('should reject a time zone on a one-shot, which the server refuses', () => {
      // Given
      const spec = {
        at: new Date(Date.now() + 60_000),
        timezone: 'Europe/Kyiv',
      } as unknown as ScheduleSpec;

      // When / Then
      expect(
        reasonOf(() => {
          validateScheduleSpec(spec);
        }),
      ).toBe(ScheduleErrorReason.InvalidTimezone);
    });

    it.each([
      { at: new Date(Date.now() + 60_000), cron: '@daily' },
      { everySeconds: 10, cron: '@daily' },
      { at: new Date(Date.now() + 60_000), everySeconds: 10 },
    ])('should reject a spec that names more than one schedule: %j', (spec) => {
      expect(
        reasonOf(() => {
          validateScheduleSpec(spec as unknown as ScheduleSpec);
        }),
      ).toBe(ScheduleErrorReason.InvalidSpec);
    });

    it('should reject an unknown time zone', () => {
      expect(
        reasonOf(() => {
          validateScheduleSpec({ cron: '@daily', timezone: 'Europe/Kiev2' });
        }),
      ).toBe(ScheduleErrorReason.InvalidTimezone);
    });

    it('should reject a spec that is neither cron nor interval', () => {
      expect(
        reasonOf(() => {
          validateScheduleSpec({} as unknown as ScheduleSpec);
        }),
      ).toBe(ScheduleErrorReason.InvalidInterval);
    });

    it('should reject an invalid cron expression', () => {
      expect(
        reasonOf(() => {
          validateScheduleSpec({ cron: '* * * * * 7' });
        }),
      ).toBe(ScheduleErrorReason.InvalidCron);
    });
  });

  describe(isCronSchedule, () => {
    it('should tell a cron from an interval', () => {
      expect(isCronSchedule({ cron: '@daily' })).toBe(true);
      expect(isCronSchedule({ everySeconds: 5 })).toBe(false);
    });
  });

  describe(assertSubjectToken, () => {
    it('should accept a single token', () => {
      expect(() => {
        assertSubjectToken(`reminder-${faker.number.int()}`, ScheduleErrorReason.InvalidId);
      }).not.toThrow();
    });

    it.each(['', 'a.b', 'a*', 'a>', 'a b', 'a\tb'])('should reject %j', (value) => {
      expect(
        reasonOf(() => {
          assertSubjectToken(value, ScheduleErrorReason.InvalidId);
        }),
      ).toBe(ScheduleErrorReason.InvalidId);
    });
  });
});
