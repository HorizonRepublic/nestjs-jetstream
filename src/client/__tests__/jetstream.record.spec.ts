import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { faker } from '@faker-js/faker';

import { JetstreamHeader, RESERVED_HEADERS } from '../../jetstream.constants';

import { JetstreamRecord, JetstreamRecordBuilder } from '../jetstream.record';

describe(JetstreamRecord, () => {
  describe('happy path', () => {
    describe('when constructed with all fields', () => {
      it('should store data, headers, and timeout', () => {
        // Given: construction args
        const data = { id: faker.number.int() };
        const headers = new Map([['x-tenant', faker.lorem.word()]]);
        const timeout = faker.number.int({ min: 1000, max: 30000 });

        // When: created
        const sut = new JetstreamRecord(data, headers, timeout);

        // Then: all fields accessible
        expect(sut.data).toEqual(data);
        expect(sut.headers).toBe(headers);
        expect(sut.timeout).toBe(timeout);
      });
    });

    describe('when constructed with schedule', () => {
      it('should store schedule options', () => {
        // Given: schedule options
        const schedule = { at: new Date(Date.now() + 60_000) };

        // When: created with schedule
        const sut = new JetstreamRecord({ id: 1 }, new Map(), undefined, undefined, schedule);

        // Then: schedule accessible
        expect(sut.schedule).toEqual(schedule);
      });
    });
  });

  describe('edge cases', () => {
    describe('when timeout is omitted', () => {
      it('should be undefined', () => {
        const sut = new JetstreamRecord('data', new Map());

        expect(sut.timeout).toBeUndefined();
      });
    });
  });
});

describe(JetstreamRecordBuilder, () => {
  let sut: JetstreamRecordBuilder;

  beforeEach(() => {
    sut = new JetstreamRecordBuilder();
  });

  afterEach(vi.resetAllMocks);

  describe('happy path', () => {
    describe('when using fluent API', () => {
      it('should build a record with all fields', () => {
        // Given: builder configured via fluent chain
        const data = { id: faker.number.int() };
        const headerKey = 'x-tenant';
        const headerVal = faker.lorem.word();
        const timeout = faker.number.int({ min: 1000, max: 30000 });

        // When: built
        const record = sut
          .setData(data)
          .setHeader(headerKey, headerVal)
          .setTimeout(timeout)
          .build();

        // Then: record contains all values
        expect(record.data).toEqual(data);
        expect(record.headers.get(headerKey)).toBe(headerVal);
        expect(record.timeout).toBe(timeout);
      });
    });

    describe('when using setMessageId()', () => {
      it('should set custom message ID for deduplication', () => {
        // Given: a custom message ID
        const messageId = `order-${faker.string.uuid()}`;

        // When: built with messageId
        const record = sut.setData({ id: 1 }).setMessageId(messageId).build();

        // Then: messageId is set
        expect(record.messageId).toBe(messageId);
      });
    });

    describe('when messageId is not set', () => {
      it('should be undefined', () => {
        // When: built without messageId
        const record = sut.setData({ id: 1 }).build();

        // Then: messageId is undefined
        expect(record.messageId).toBeUndefined();
      });
    });

    describe('when using setHeaders() with multiple entries', () => {
      it('should set all headers at once', () => {
        // Given: multiple headers
        const headers = { 'x-tenant': faker.lorem.word(), 'x-region': faker.lorem.word() };

        // When: built
        const record = sut.setHeaders(headers).build();

        // Then: all headers present
        expect(record.headers.get('x-tenant')).toBe(headers['x-tenant']);
        expect(record.headers.get('x-region')).toBe(headers['x-region']);
      });
    });

    describe('when data is provided in constructor', () => {
      it('should use constructor data', () => {
        // Given: data passed to constructor
        const data = faker.lorem.word();

        // When: built without setData
        const record = new JetstreamRecordBuilder(data).build();

        // Then: constructor data used
        expect(record.data).toBe(data);
      });
    });
  });

  describe('edge cases', () => {
    describe('when building creates an independent copy', () => {
      it('should not be affected by subsequent builder mutations', () => {
        // Given: a built record
        sut.setHeader('x-a', '1');
        const record = sut.build();

        // When: builder is mutated after build
        sut.setHeader('x-b', '2');

        // Then: record is unaffected
        expect(record.headers.has('x-b')).toBe(false);
      });
    });
  });

  describe('scheduleAt()', () => {
    describe('happy path', () => {
      describe('when scheduling a future date', () => {
        it('should include schedule in built record', () => {
          // Given: a future date
          const futureDate = new Date(Date.now() + 60_000);

          // When: built with scheduleAt
          const record = sut.setData({ id: 1 }).scheduleAt(futureDate).build();

          // Then: record contains schedule
          expect(record.schedule).toEqual({ at: futureDate });
        });
      });

      describe('when scheduleAt is not called', () => {
        it('should have undefined schedule in built record', () => {
          // When: built without scheduleAt
          const record = sut.setData({ id: 1 }).build();

          // Then: no schedule
          expect(record.schedule).toBeUndefined();
        });
      });
    });

    describe('error paths', () => {
      describe('when date is in the past', () => {
        it('should throw an error', () => {
          // Given: a past date
          const pastDate = new Date(Date.now() - 60_000);

          // When/Then: throws
          expect(() => sut.scheduleAt(pastDate)).toThrow(/future/i);
        });
      });

      describe('when date is exactly now', () => {
        it('should throw an error', () => {
          // Given: current date (use vi.useFakeTimers for determinism)
          vi.useFakeTimers();

          try {
            const now = new Date();

            // When/Then: throws (now is not in the future)
            expect(() => sut.scheduleAt(now)).toThrow(/future/i);
          } finally {
            vi.useRealTimers();
          }
        });
      });

      describe('when date is invalid', () => {
        it('should throw an error', () => {
          // Given: an invalid date
          const invalidDate = new Date('invalid');

          // When/Then: throws
          expect(() => sut.scheduleAt(invalidDate)).toThrow(/invalid/i);
        });
      });
    });
  });

  describe('error paths', () => {
    describe('when setting reserved headers via setHeader()', () => {
      it.each([...RESERVED_HEADERS])('should throw for reserved header: %s', (header) => {
        expect(() => sut.setHeader(header, 'value')).toThrow(/reserved/i);
      });

      it('should include the header name in the error message', () => {
        expect(() => sut.setHeader(JetstreamHeader.CorrelationId, 'x')).toThrow(/x-correlation-id/);
      });
    });

    describe('when setting reserved headers via setHeaders()', () => {
      it('should throw when any entry is reserved', () => {
        expect(() =>
          sut.setHeaders({
            'x-tenant': 'ok',
            [JetstreamHeader.Error]: 'true',
          }),
        ).toThrow(/x-error.*reserved/i);
      });
    });
  });
});
