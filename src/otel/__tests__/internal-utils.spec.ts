import { describe, expect, it, vi } from 'vitest';
import { faker } from '@faker-js/faker';

import { parseServerAddress, safelyInvokeHook } from '../internal-utils';

describe('safelyInvokeHook', () => {
  it('should be a no-op when hook is undefined', () => {
    // When + Then — no throw
    expect(() => {
      safelyInvokeHook('publishHook', undefined);
    }).not.toThrow();
  });

  it('should forward arguments to the hook', () => {
    // Given
    const hook = vi.fn();
    const arg1 = faker.string.uuid();
    const arg2 = { foo: faker.lorem.word() };

    // When
    safelyInvokeHook('publishHook', hook, arg1, arg2);

    // Then
    expect(hook).toHaveBeenCalledWith(arg1, arg2);
  });

  it('should swallow exceptions thrown by the hook', () => {
    // Given
    const hook = vi.fn().mockImplementation(() => {
      throw new Error('hook boom');
    });

    // When + Then — must not propagate
    expect(() => {
      safelyInvokeHook('publishHook', hook, 'arg');
    }).not.toThrow();
  });
});

describe('parseServerAddress', () => {
  it('should return null when the servers list is empty — caller skips server.* attributes', () => {
    expect(parseServerAddress([])).toBeNull();
  });

  it('should parse a `nats://host:port` URL', () => {
    expect(parseServerAddress(['nats://nats.prod:4222'])).toEqual({
      host: 'nats.prod',
      port: 4222,
    });
  });

  it('should parse a host:port without scheme', () => {
    expect(parseServerAddress(['nats.local:4222'])).toEqual({ host: 'nats.local', port: 4222 });
  });

  it('should omit the port attribute when the URL has no explicit port', () => {
    // User wrote `nats://nats.local` — no invented port.
    expect(parseServerAddress(['nats://nats.local'])).toEqual({ host: 'nats.local' });
  });

  it('should return null for a malformed URL — caller drops server.* silently', () => {
    expect(parseServerAddress([':invalid:'])).toBeNull();
  });

  it('should parse a `tls://` URL and strip the scheme', () => {
    expect(parseServerAddress(['tls://secure.nats.example:4443'])).toEqual({
      host: 'secure.nats.example',
      port: 4443,
    });
  });

  it('should strip userinfo from the authority', () => {
    expect(parseServerAddress(['nats://user:pass@nats.prod:4222'])).toEqual({
      host: 'nats.prod',
      port: 4222,
    });
  });

  it('should parse a bare IPv6 authority without a scheme', () => {
    // Brackets stripped per OTel `server.address` convention.
    expect(parseServerAddress(['[::1]:4222'])).toEqual({ host: '::1', port: 4222 });
  });

  it('should parse a scheme-qualified IPv6 URL and strip brackets from the hostname', () => {
    // Documentation-space address (RFC 3849) rather than a real link-local literal.
    expect(parseServerAddress(['nats://[2001:db8::1]:4222'])).toEqual({
      host: '2001:db8::1',
      port: 4222,
    });
  });

  it('should omit the port when the parsed value is not a valid integer', () => {
    // We don't validate the TCP range — that's NATS's job when it tries to
    // connect. We just refuse to emit a nonsense integer as `server.port`.
    expect(parseServerAddress(['nats.local:not-a-number'])).toEqual({ host: 'nats.local' });
  });
});
