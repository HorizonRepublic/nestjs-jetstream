import { describe, it, expect } from 'vitest';

import { mapErrorContext } from '../error-context-mapper';

describe(mapErrorContext, () => {
  describe('happy path', () => {
    it('should map a connection context to "connection"', () => {
      // Given/When
      const result = mapErrorContext('connection');

      // Then
      expect(result).toBe('connection');
    });

    it.each([
      ['client-rpc', 'publish'],
      ['jetstream-rpc-publish:orders.create', 'publish'],
      ['core-rpc-handler:user.get', 'handler'],
      ['rpc-handler:order.create', 'handler'],
      ['event-handler:order.created', 'handler'],
      ['broadcast-handler:cache.invalidate', 'handler'],
      ['ordered-handler:audit.log', 'handler'],
      ['message-provider', 'consume'],
      ['shutdown', 'shutdown'],
    ])('should map %s to %s', (input, expected) => {
      expect(mapErrorContext(input)).toBe(expected);
    });
  });

  describe('edge cases', () => {
    it('should return "other" when context is undefined', () => {
      expect(mapErrorContext(undefined)).toBe('other');
    });

    it('should return "other" when context does not match any known prefix', () => {
      expect(mapErrorContext('totally-novel-context')).toBe('other');
    });

    it('should match by prefix, not full string', () => {
      // Given a context that starts with a known prefix but has trailing detail
      expect(mapErrorContext('connection:nats://localhost:4222')).toBe('connection');
    });
  });
});
