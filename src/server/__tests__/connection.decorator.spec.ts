import 'reflect-metadata';
import { EventPattern, MessagePattern } from '@nestjs/microservices';
import { PATTERN_EXTRAS_METADATA, PATTERN_METADATA } from '@nestjs/microservices/constants';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { JetstreamConnection } from '../connection.decorator';

const extrasOf = (target: object, key: string): Record<string, unknown> =>
  (Reflect.getMetadata(PATTERN_EXTRAS_METADATA, (target as Record<string, unknown>)[key]!) ??
    {}) as Record<string, unknown>;

describe('JetstreamConnection', () => {
  afterEach(vi.resetAllMocks);

  it('should tag every pattern handler on the class', () => {
    // Given a controller with two handlers
    @JetstreamConnection('analytics')
    class Sut {
      @EventPattern('a.happened')
      public onA(): void {}

      @MessagePattern('a.query')
      public queryA(): void {}
    }

    // When metadata is read
    // Then both carry the connection
    expect(extrasOf(Sut.prototype, 'onA').connection).toBe('analytics');
    expect(extrasOf(Sut.prototype, 'queryA').connection).toBe('analytics');
  });

  it('should preserve existing extras', () => {
    // Given a handler with its own extras
    @JetstreamConnection('analytics')
    class Sut {
      @EventPattern('b.happened', { broadcast: true })
      public onB(): void {}
    }

    // When metadata is read
    // Then the original extras survive alongside the connection
    const extras = extrasOf(Sut.prototype, 'onB');

    expect(extras.broadcast).toBe(true);
    expect(extras.connection).toBe('analytics');
  });

  it('should not override a method that already declares a connection', () => {
    // Given a method-level connection that disagrees with the class
    @JetstreamConnection('analytics')
    class Sut {
      @EventPattern('c.happened', { connection: 'primary' })
      public onC(): void {}
    }

    // When metadata is read
    // Then the method wins
    expect(extrasOf(Sut.prototype, 'onC').connection).toBe('primary');
  });

  it('should ignore methods without a pattern', () => {
    // Given a plain method next to a handler
    @JetstreamConnection('analytics')
    class Sut {
      @EventPattern('d.happened')
      public onD(): void {}

      public helper(): void {}
    }

    // When metadata is read
    // Then the plain method is untouched
    expect(extrasOf(Sut.prototype, 'helper').connection).toBeUndefined();
  });

  it('should depend on metadata keys that NestJS still exports', () => {
    // Given the constants the decorator reads
    // When their values are checked
    // Then they match the documented microservices metadata contract
    expect(PATTERN_METADATA).toBe('microservices:pattern');
    expect(PATTERN_EXTRAS_METADATA).toBe('microservices:pattern_extras');
  });
});
