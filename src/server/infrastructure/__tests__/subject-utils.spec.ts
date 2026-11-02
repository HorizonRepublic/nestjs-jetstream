import { describe, expect, it } from 'vitest';

import { subjectCovers, minimalSubjectFilters, subjectsOverlap } from '../subject-utils';

describe('subjectCovers', () => {
  it.each([
    ['broadcast.>', 'broadcast.config.updated', true],
    ['broadcast.>', 'broadcast._sch.x.y', true],
    ['broadcast.>', 'broadcast', false],
    ['a.*.c', 'a.b.c', true],
    ['a.*', 'a.b.c', false],
    ['a.b', 'a.b', false],
    ['svc.ev.>', 'svc._sch.x', false],
  ])('%s covers %s -> %s', (broad, narrow, expected) => {
    expect(subjectCovers(broad, narrow)).toBe(expected);
  });
});

describe('wildcard filter normalization', () => {
  it('removes covered exact filters and duplicates', () => {
    expect(
      minimalSubjectFilters(['orders.*', 'orders.created', 'orders.*', 'users.created']),
    ).toEqual(['orders.*', 'users.created']);
  });
  it('keeps the bare prefix outside a trailing wildcard', () => {
    expect(minimalSubjectFilters(['orders.>', 'orders', 'orders.eu.created'])).toEqual([
      'orders.>',
      'orders',
    ]);
  });
  it('detects intersections but respects the nonempty tail', () => {
    expect(subjectsOverlap('orders.*', '*.created')).toBe(true);
    expect(subjectsOverlap('orders.>', 'orders')).toBe(false);
    expect(subjectsOverlap('orders.*', 'users.*')).toBe(false);
  });
});
