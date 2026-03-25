import { beforeEach, describe, expect, it } from 'vitest';
import { faker } from '@faker-js/faker';
import { StoreCompression } from 'nats';

import type { StreamKind } from './interfaces';
import {
  buildBroadcastSubject,
  buildSubject,
  consumerName,
  DEFAULT_BROADCAST_STREAM_CONFIG,
  DEFAULT_COMMAND_STREAM_CONFIG,
  DEFAULT_EVENT_STREAM_CONFIG,
  DEFAULT_ORDERED_STREAM_CONFIG,
  getClientToken,
  internalName,
  toNanos,
  streamName,
} from './jetstream.constants';

describe('jetstream.constants', () => {
  describe(toNanos.name, () => {
    it.each([
      [1, 'ms', 1_000_000],
      [1, 'seconds', 1_000_000_000],
      [2, 'minutes', 120_000_000_000],
      [1, 'hours', 3_600_000_000_000],
      [1, 'days', 86_400_000_000_000],
      [0, 'seconds', 0],
    ] as const)('should convert %d %s to %d nanoseconds', (value, unit, expected) => {
      expect(toNanos(value, unit)).toBe(expected);
    });
  });

  describe(getClientToken.name, () => {
    it('should return the service name as-is', () => {
      const name = faker.lorem.word();

      expect(getClientToken(name)).toBe(name);
    });
  });

  describe(internalName.name, () => {
    it('should append __microservice suffix', () => {
      const name = faker.lorem.word();

      expect(internalName(name)).toBe(`${name}__microservice`);
    });
  });

  describe(buildSubject.name, () => {
    let serviceName: string;

    beforeEach(() => {
      serviceName = faker.lorem.word();
    });

    it('should build cmd subject', () => {
      const pattern = faker.lorem.word();

      expect(buildSubject(serviceName, 'cmd', pattern)).toBe(
        `${serviceName}__microservice.cmd.${pattern}`,
      );
    });

    it('should build ev subject', () => {
      const pattern = faker.lorem.word();

      expect(buildSubject(serviceName, 'ev', pattern)).toBe(
        `${serviceName}__microservice.ev.${pattern}`,
      );
    });
  });

  describe(buildBroadcastSubject.name, () => {
    it('should prefix with broadcast.', () => {
      const pattern = faker.lorem.word();

      expect(buildBroadcastSubject(pattern)).toBe(`broadcast.${pattern}`);
    });
  });

  describe(streamName.name, () => {
    let serviceName: string;

    beforeEach(() => {
      serviceName = faker.lorem.word();
    });

    it.each<[StreamKind, string]>([
      ['ev', 'ev-stream'],
      ['cmd', 'cmd-stream'],
    ])('should build %s stream name with service prefix', (kind, suffix) => {
      expect(streamName(serviceName, kind)).toBe(`${serviceName}__microservice_${suffix}`);
    });

    it('should return fixed name for broadcast', () => {
      expect(streamName(serviceName, 'broadcast')).toBe('broadcast-stream');
    });
  });

  describe('stream compression defaults', () => {
    // Given: default stream configs are used without explicit compression override
    it('should default to S2 compression for event streams', () => {
      // Then: compression is set to S2
      expect(DEFAULT_EVENT_STREAM_CONFIG.compression).toBe(StoreCompression.S2);
    });

    it('should default to S2 compression for command streams', () => {
      expect(DEFAULT_COMMAND_STREAM_CONFIG.compression).toBe(StoreCompression.S2);
    });

    it('should default to S2 compression for broadcast streams', () => {
      expect(DEFAULT_BROADCAST_STREAM_CONFIG.compression).toBe(StoreCompression.S2);
    });

    it('should default to S2 compression for ordered streams', () => {
      expect(DEFAULT_ORDERED_STREAM_CONFIG.compression).toBe(StoreCompression.S2);
    });
  });

  describe(consumerName.name, () => {
    let serviceName: string;

    beforeEach(() => {
      serviceName = faker.lorem.word();
    });

    it.each<[StreamKind, string]>([
      ['ev', 'ev-consumer'],
      ['cmd', 'cmd-consumer'],
    ])('should build %s consumer name with service prefix', (kind, suffix) => {
      expect(consumerName(serviceName, kind)).toBe(`${serviceName}__microservice_${suffix}`);
    });

    it('should include service prefix for broadcast consumer', () => {
      expect(consumerName(serviceName, 'broadcast')).toBe(
        `${serviceName}__microservice_broadcast-consumer`,
      );
    });
  });
});
