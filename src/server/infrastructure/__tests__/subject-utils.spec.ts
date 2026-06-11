import { describe, expect, it } from 'vitest';

import { subjectCovers } from '../subject-utils';

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
