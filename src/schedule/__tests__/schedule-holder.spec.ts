import type { StoredMsg } from '@nats-io/jetstream';
import type { MsgHdrs } from '@nats-io/transport-node';
import { headers } from '@nats-io/transport-node';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScheduleOrigin } from '../../interfaces';
import { JetstreamHeader } from '../../jetstream.constants';
import { buildHolder, definitionHash, readHolder } from '../schedule-holder';

const NOW = new Date('2026-10-23T12:00:00Z');
const PREFIX = 'svc__microservice._cron.';
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const WRITTEN_AT = new Date('2026-10-01T00:00:00Z');

const stored = (subject: string, seq: number, hdrs: MsgHdrs = headers()): StoredMsg =>
  createMock<StoredMsg>({ subject, seq, header: hdrs, time: WRITTEN_AT });

describe('schedule holder', () => {
  afterEach(vi.resetAllMocks);

  describe(definitionHash, () => {
    const base = (): Parameters<typeof definitionHash> => [
      'sync.tick',
      '0 */10 * * * *',
      'Europe/Kyiv',
      600,
      encode('{}'),
    ];

    it('should be stable for the same definition', () => {
      expect(definitionHash(...base())).toBe(definitionHash(...base()));
    });

    it.each([
      ['pattern', 0, 'sync.tock'],
      ['specification', 1, '@every 600s'],
      ['timezone', 2, undefined],
      ['ttl', 3, 60],
      ['payload', 4, encode('{"a":1}')],
    ])('should change when the %s changes', (_, index, value) => {
      // Given
      const changed = base();

      changed[index] = value as never;

      // When / Then
      expect(definitionHash(...changed)).not.toBe(definitionHash(...base()));
    });

    it('should not confuse a value moved across fields', () => {
      expect(definitionHash('a.b', 'c', undefined, 1, encode(''))).not.toBe(
        definitionHash('a', 'b.c', undefined, 1, encode('')),
      );
    });
  });

  describe(buildHolder, () => {
    it('should hash the same definition the same way whatever month it boots in', () => {
      // Given a monthly cron, whose computed tick TTL differs between January and March
      const build = (now: string): string =>
        buildHolder(
          `${PREFIX}decl.report`,
          't',
          'report',
          { cron: '@monthly' },
          encode(''),
          new Date(now),
        ).hash;

      // When / Then
      expect(build('2027-01-15T00:00:00Z')).toBe(build('2027-03-15T00:00:00Z'));
    });

    it('should carry the schedule, target, ttl, zone, pattern and hash', () => {
      // Given
      const target = `svc__microservice.sched.sync.tick`;

      // When
      const sut = buildHolder(
        `${PREFIX}decl.sync.tick`,
        target,
        'sync.tick',
        { cron: '0 */10 * * * *', timezone: 'Europe/Kyiv' },
        encode('{}'),
        NOW,
      );

      // Then
      expect(sut.options.schedule).toEqual({
        specification: '0 */10 * * * *',
        target,
        ttl: '600s',
        timezone: 'Europe/Kyiv',
      });
      expect(sut.options.headers?.get(JetstreamHeader.SchedulePattern)).toBe('sync.tick');
      expect(sut.options.headers?.get(JetstreamHeader.ScheduleHash)).toBe(sut.hash);
      expect(sut.options.msgID).toBeUndefined();
      expect(sut.options.headers?.has('traceparent')).toBe(false);
    });

    it('should omit the ttl and zone a one-shot does not have', () => {
      // When
      const sut = buildHolder(
        `${PREFIX}dyn.r-1`,
        'svc__microservice.sched.reminder.due',
        'reminder.due',
        { at: new Date('2027-01-01T00:00:00Z') },
        encode('{}'),
        NOW,
      );

      // Then
      expect(sut.options.schedule).toEqual({
        specification: '@at 2027-01-01T00:00:00.000Z',
        target: 'svc__microservice.sched.reminder.due',
      });
    });
  });

  describe(readHolder, () => {
    it('should read a declared holder back', () => {
      // Given a holder as the server stores it
      const holder = buildHolder(
        `${PREFIX}decl.sync.tick`,
        'svc__microservice.sched.sync.tick',
        'sync.tick',
        { cron: '0 */10 * * * *', timezone: 'Europe/Kyiv' },
        encode('{}'),
        NOW,
      );
      const hdrs = holder.options.headers;

      hdrs?.set('Nats-Schedule', '0 */10 * * * *');
      hdrs?.set('Nats-Schedule-TTL', '600s');
      hdrs?.set('Nats-Schedule-Time-Zone', 'Europe/Kyiv');

      // When
      const sut = readHolder(stored(holder.subject, 7, hdrs), PREFIX);

      // Then
      expect(sut).toEqual({
        subject: holder.subject,
        seq: 7,
        hash: holder.hash,
        writtenAt: WRITTEN_AT,
        info: {
          id: 'sync.tick',
          origin: ScheduleOrigin.Declared,
          pattern: 'sync.tick',
          specification: '0 */10 * * * *',
          timezone: 'Europe/Kyiv',
          ttlSeconds: 600,
        },
      });
    });

    it('should read a dynamic holder without ttl or zone', () => {
      // Given
      const id = `reminder-${faker.number.int()}`;
      const holder = buildHolder(
        `${PREFIX}dyn.${id}`,
        'svc__microservice.sched.reminder.due',
        'reminder.due',
        { everySeconds: 60, ttlSeconds: 60 },
        encode('{}'),
        NOW,
      );

      holder.options.headers?.set('Nats-Schedule', '@every 60s');

      // When
      const sut = readHolder(stored(holder.subject, 3, holder.options.headers), PREFIX);

      // Then
      expect(sut?.info).toEqual({
        id,
        origin: ScheduleOrigin.Dynamic,
        pattern: 'reminder.due',
        specification: '@every 60s',
      });
    });

    it('should skip a message outside the holder namespaces or without our headers', () => {
      expect(readHolder(stored(`${PREFIX}other.x`, 1), PREFIX)).toBeNull();
      expect(readHolder(stored(`${PREFIX}dyn.x`, 1), PREFIX)).toBeNull();
    });
  });
});
