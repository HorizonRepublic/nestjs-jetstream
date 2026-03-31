import { beforeEach, describe, expect, it } from 'vitest';
import { faker } from '@faker-js/faker';
import { StoreCompression } from 'nats';

import { StreamKind } from './interfaces';
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

    it('should build command subject', () => {
      const pattern = faker.lorem.word();

      expect(buildSubject(serviceName, StreamKind.Command, pattern)).toBe(
        `${serviceName}__microservice.cmd.${pattern}`,
      );
    });

    it('should build event subject', () => {
      const pattern = faker.lorem.word();

      expect(buildSubject(serviceName, StreamKind.Event, pattern)).toBe(
        `${serviceName}__microservice.ev.${pattern}`,
      );
    });

    it('should build ordered subject', () => {
      const pattern = faker.lorem.word();

      expect(buildSubject(serviceName, StreamKind.Ordered, pattern)).toBe(
        `${serviceName}__microservice.ordered.${pattern}`,
      );
    });

    it('should produce incorrect subject for arbitrary string', () => {
      const pattern = faker.lorem.word();
      const invalidKind = 'invalid-kind' as never;

      expect(buildSubject(serviceName, invalidKind, pattern)).not.toMatch(/\.(ev|cmd|ordered)\./);
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
      [StreamKind.Event, 'ev-stream'],
      [StreamKind.Command, 'cmd-stream'],
      [StreamKind.Ordered, 'ordered-stream'],
    ])('should build %s stream name with service prefix', (kind, suffix) => {
      expect(streamName(serviceName, kind)).toBe(`${serviceName}__microservice_${suffix}`);
    });

    it('should return fixed name for broadcast', () => {
      expect(streamName(serviceName, StreamKind.Broadcast)).toBe('broadcast-stream');
    });

    it('should produce incorrect stream name for arbitrary string', () => {
      const invalidKind = 'invalid-kind' as never;

      expect(streamName(serviceName, invalidKind)).not.toMatch(
        /_(ev|cmd|ordered|broadcast)-stream$/,
      );
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
      [StreamKind.Event, 'ev-consumer'],
      [StreamKind.Command, 'cmd-consumer'],
    ])('should build %s consumer name with service prefix', (kind, suffix) => {
      expect(consumerName(serviceName, kind)).toBe(`${serviceName}__microservice_${suffix}`);
    });

    it('should include service prefix for broadcast consumer', () => {
      expect(consumerName(serviceName, StreamKind.Broadcast)).toBe(
        `${serviceName}__microservice_broadcast-consumer`,
      );
    });

    it('should produce incorrect consumer name for arbitrary string', () => {
      const invalidKind = 'invalid-kind' as never;

      expect(consumerName(serviceName, invalidKind)).not.toMatch(
        /_(ev|cmd|ordered|broadcast)-consumer$/,
      );
    });
  });
});
