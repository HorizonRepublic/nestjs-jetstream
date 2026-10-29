import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { matchesDeadLetter } from '../dead-letter-filter';
import { DeadLetterOrigin, type DeadLetterRecord } from '../dlq.types';

const record = (overrides: Partial<DeadLetterRecord> = {}): DeadLetterRecord => ({
  seq: 10,
  subject: 'orders__microservice.ev.order.created',
  stream: 'orders__microservice_ev-stream',
  origin: DeadLetterOrigin.Event,
  pattern: 'order.created',
  reason: 'payment gateway timeout',
  failedAt: new Date('2026-10-28T12:00:00Z'),
  deliveryCount: 5,
  redriveCount: 0,
  headers: {},
  data: new Uint8Array(),
  payload: { id: faker.string.uuid() },
  ...overrides,
});

describe(matchesDeadLetter, () => {
  it('should match everything with an empty filter', () => {
    expect(matchesDeadLetter(record(), {})).toBe(true);
  });

  it.each([
    ['orders__microservice.ev.order.created', true],
    ['orders__microservice.ev.order.*', true],
    ['orders__microservice.ev.>', true],
    ['orders__microservice.ev.order.paid', false],
    ['orders__microservice.ev.*', false],
  ])('should match subject %s: %s', (subject, expected) => {
    expect(matchesDeadLetter(record(), { subject })).toBe(expected);
  });

  it('should match the declared pattern exactly', () => {
    expect(matchesDeadLetter(record(), { pattern: 'order.created' })).toBe(true);
    expect(matchesDeadLetter(record(), { pattern: 'order' })).toBe(false);
    expect(matchesDeadLetter(record({ pattern: undefined }), { pattern: 'order.created' })).toBe(
      false,
    );
  });

  it('should match a reason by substring or by expression', () => {
    expect(matchesDeadLetter(record(), { reason: 'gateway' })).toBe(true);
    expect(matchesDeadLetter(record(), { reason: /^payment .* timeout$/ })).toBe(true);
    expect(matchesDeadLetter(record(), { reason: 'decode' })).toBe(false);
  });

  it('should match every record with a global expression, not every other one', () => {
    const reason = /timeout/g;

    expect([1, 2, 3].map(() => matchesDeadLetter(record(), { reason }))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('should keep failures inside the time window, bounds included', () => {
    const at = new Date('2026-10-28T12:00:00Z');

    expect(matchesDeadLetter(record(), { failedAfter: at, failedBefore: at })).toBe(true);
    expect(matchesDeadLetter(record(), { failedAfter: new Date('2026-10-29T00:00:00Z') })).toBe(
      false,
    );
    expect(matchesDeadLetter(record(), { failedBefore: new Date('2026-10-27T00:00:00Z') })).toBe(
      false,
    );
  });

  it('should leave out a record without a failure time once a window is set', () => {
    expect(matchesDeadLetter(record({ failedAt: undefined }), { failedAfter: new Date(0) })).toBe(
      false,
    );
  });

  it('should keep sequences inside the range, bounds included', () => {
    expect(matchesDeadLetter(record(), { fromSeq: 10, toSeq: 10 })).toBe(true);
    expect(matchesDeadLetter(record(), { fromSeq: 11 })).toBe(false);
    expect(matchesDeadLetter(record(), { toSeq: 9 })).toBe(false);
  });

  it('should require every criterion to match', () => {
    expect(matchesDeadLetter(record(), { pattern: 'order.created', reason: 'decode' })).toBe(false);
  });
});
