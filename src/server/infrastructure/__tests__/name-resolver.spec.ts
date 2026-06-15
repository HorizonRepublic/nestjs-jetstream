import { describe, expect, it } from 'vitest';

import { StreamKind } from '../../../interfaces';
import type { JetstreamModuleOptions } from '../../../interfaces';
import {
  buildBroadcastSubject,
  buildSubject,
  consumerName,
  dlqStreamName,
  streamName,
} from '../../../jetstream.constants';
import { NameResolver } from '../name-resolver';

const base: JetstreamModuleOptions = { name: 'orders', servers: ['nats://localhost:4222'] };

describe(NameResolver, () => {
  describe('convention parity (no overrides)', () => {
    const sut = new NameResolver(base);

    it.each([StreamKind.Event, StreamKind.Command, StreamKind.Broadcast, StreamKind.Ordered])(
      'streamName(%s) matches the convention',
      (kind) => {
        expect(sut.streamName(kind)).toBe(streamName('orders', kind));
      },
    );

    it.each([StreamKind.Event, StreamKind.Command, StreamKind.Broadcast])(
      'consumerName(%s) matches the convention',
      (kind) => {
        expect(sut.consumerName(kind)).toBe(consumerName('orders', kind));
      },
    );

    it('dlqStreamName matches the convention', () => {
      expect(sut.dlqStreamName()).toBe(dlqStreamName('orders'));
    });

    it('subject() matches buildSubject/buildBroadcastSubject', () => {
      expect(sut.subject(StreamKind.Event, 'order.created')).toBe(
        buildSubject('orders', StreamKind.Event, 'order.created'),
      );
      expect(sut.subject(StreamKind.Broadcast, 'config.updated')).toBe(
        buildBroadcastSubject('config.updated'),
      );
    });

    it('filterSubject() is the wildcard over the prefix', () => {
      expect(sut.filterSubject(StreamKind.Event)).toBe('orders__microservice.ev.>');
      expect(sut.filterSubject(StreamKind.Broadcast)).toBe('broadcast.>');
    });

    it('schedulePrefix() is the sibling _sch namespace', () => {
      expect(sut.schedulePrefix(StreamKind.Event)).toBe('orders__microservice._sch.');
      expect(sut.schedulePrefix(StreamKind.Broadcast)).toBe('broadcast._sch.');
    });

    it('hasCustomPrefix() is false', () => {
      expect(sut.hasCustomPrefix(StreamKind.Event)).toBe(false);
    });
  });

  describe('custom inputs', () => {
    const options: JetstreamModuleOptions = {
      ...base,
      events: {
        stream: { name: 'company_orders_stream' },
        consumer: { durable_name: 'company_worker' },
        subjectPrefix: 'company.orders',
      },
      dlq: { stream: { name: 'company_dlq' } },
    };
    const sut = new NameResolver(options);

    it('honors custom stream and consumer names', () => {
      expect(sut.streamName(StreamKind.Event)).toBe('company_orders_stream');
      expect(sut.consumerName(StreamKind.Event)).toBe('company_worker');
      expect(sut.dlqStreamName()).toBe('company_dlq');
    });

    it('normalizes the prefix and builds subjects from it', () => {
      expect(sut.subject(StreamKind.Event, 'order.created')).toBe('company.orders.order.created');
      expect(sut.filterSubject(StreamKind.Event)).toBe('company.orders.>');
      expect(sut.schedulePrefix(StreamKind.Event)).toBe('company.orders._sch.');
      expect(sut.hasCustomPrefix(StreamKind.Event)).toBe(true);
    });

    it('leaves kinds without overrides on the convention', () => {
      expect(sut.streamName(StreamKind.Broadcast)).toBe(streamName('orders', StreamKind.Broadcast));
      expect(sut.hasCustomPrefix(StreamKind.Broadcast)).toBe(false);
    });
  });

  describe('custom prefix normalization', () => {
    it('trailing-dot and no-dot inputs yield the same prefix', () => {
      const withDot = new NameResolver({
        ...base,
        events: { subjectPrefix: 'company.orders.' },
      });
      const withoutDot = new NameResolver({
        ...base,
        events: { subjectPrefix: 'company.orders' },
      });

      expect(withDot.filterSubject(StreamKind.Event)).toBe(
        withoutDot.filterSubject(StreamKind.Event),
      );
      expect(withDot.subject(StreamKind.Event, 'foo')).toBe(
        withoutDot.subject(StreamKind.Event, 'foo'),
      );
    });

    it('collapses multiple trailing dots into a single separator', () => {
      const sut = new NameResolver({ ...base, events: { subjectPrefix: 'company.orders..' } });

      expect(sut.subject(StreamKind.Event, 'foo')).toBe('company.orders.foo');
    });

    it.each(['', '.', 'company..orders', 'company.>.orders'])(
      'rejects invalid subjectPrefix %j at construction',
      (subjectPrefix) => {
        expect(() => new NameResolver({ ...base, events: { subjectPrefix } })).toThrow(
          /Invalid subjectPrefix/,
        );
      },
    );
  });
});
