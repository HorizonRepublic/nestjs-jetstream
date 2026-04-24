import { afterEach, describe, expect, it, vi } from 'vitest';
import { faker } from '@faker-js/faker';
import { headers as natsHeaders } from '@nats-io/transport-node';

import {
  captureBodyAttribute,
  captureMatchingHeaders,
  compileHeaderAllowlist,
  subjectMatchesAllowlist,
} from '../capture';

describe('compileHeaderAllowlist', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should match every header when given true', () => {
    // Given
    const sut = compileHeaderAllowlist(true);

    // When + Then
    expect(sut(faker.lorem.word())).toBe(true);
  });

  it('should match nothing when given false', () => {
    // Given
    const sut = compileHeaderAllowlist(false);

    // When + Then
    expect(sut('x-correlation-id')).toBe(false);
  });

  it('should match nothing when given an empty array', () => {
    // Given
    const sut = compileHeaderAllowlist([]);

    // When + Then
    expect(sut('x-correlation-id')).toBe(false);
  });

  it('should match exact header names case-insensitively', () => {
    // Given
    const sut = compileHeaderAllowlist(['x-correlation-id']);

    // When + Then
    expect(sut('x-correlation-id')).toBe(true);
    expect(sut('X-Correlation-Id')).toBe(true);
    expect(sut('x-other')).toBe(false);
  });

  it('should expand `*` glob wildcards', () => {
    // Given
    const sut = compileHeaderAllowlist(['x-*', '*-id']);

    // When + Then
    expect(sut('x-anything')).toBe(true);
    expect(sut('request-id')).toBe(true);
    expect(sut('authorization')).toBe(false);
  });

  it('should honor `!` exclusion patterns after include matching', () => {
    // Given
    const sut = compileHeaderAllowlist(['x-*', '!x-internal-*']);

    // When + Then
    expect(sut('x-tenant')).toBe(true);
    expect(sut('x-internal-secret')).toBe(false);
  });

  it('should treat exclusion-only allowlists as match-none', () => {
    // Given
    const sut = compileHeaderAllowlist(['!x-internal-*']);

    // When + Then
    expect(sut('x-tenant')).toBe(false);
    expect(sut('x-internal-anything')).toBe(false);
  });
});

describe('subjectMatchesAllowlist', () => {
  it('should match anything when allowlist is undefined', () => {
    // When + Then
    expect(subjectMatchesAllowlist(faker.lorem.word(), undefined)).toBe(true);
  });

  it('should match anything when allowlist is empty', () => {
    // When + Then
    expect(subjectMatchesAllowlist('orders.created', [])).toBe(true);
  });

  it('should glob-match each pattern case-insensitively', () => {
    // When + Then
    expect(subjectMatchesAllowlist('Orders.Created', ['orders.*'])).toBe(true);
    expect(subjectMatchesAllowlist('inventory.updated', ['orders.*'])).toBe(false);
  });
});

describe('captureMatchingHeaders', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should return an empty object when headers are absent', () => {
    // Given
    const matcher = compileHeaderAllowlist(true);

    // When
    const result = captureMatchingHeaders(undefined, matcher);

    // Then
    expect(result).toEqual({});
  });

  it('should emit `messaging.header.<lowercase-key>` for matching headers', () => {
    // Given
    const hdrs = natsHeaders();
    const requestId = faker.string.uuid();

    hdrs.set('x-request-id', requestId);
    hdrs.set('x-other', 'ignored');

    const matcher = compileHeaderAllowlist(['x-request-id']);

    // When
    const result = captureMatchingHeaders(hdrs, matcher);

    // Then
    expect(result).toEqual({ 'messaging.header.x-request-id': requestId });
  });

  it('should never emit propagator-owned headers even when the matcher passes', () => {
    // Given
    const hdrs = natsHeaders();

    hdrs.set('traceparent', '00-aaaa-bbbb-01');
    hdrs.set('sentry-trace', 'something');
    hdrs.set('b3', 'values');

    const matcher = compileHeaderAllowlist(true);

    // When
    const result = captureMatchingHeaders(hdrs, matcher);

    // Then
    expect(result).toEqual({});
  });

  it('should never emit transport-internal headers even when allowlisted explicitly', () => {
    // Given — user tries to capture the internal correlation id and the transport subject.
    const hdrs = natsHeaders();

    hdrs.set('x-correlation-id', faker.string.uuid());
    hdrs.set('x-reply-to', 'inbox.abc');
    hdrs.set('x-subject', 'orders.placed');
    hdrs.set('x-caller-name', 'billing');

    const matcher = compileHeaderAllowlist([
      'x-correlation-id',
      'x-reply-to',
      'x-subject',
      'x-caller-name',
    ]);

    // When
    const result = captureMatchingHeaders(hdrs, matcher);

    // Then
    expect(result).toEqual({});
  });
});

describe('captureBodyAttribute', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should return an empty object when capture is disabled', () => {
    // When
    const result = captureBodyAttribute('orders.created', new Uint8Array([1, 2, 3]), false);

    // Then
    expect(result).toEqual({});
  });

  it('should return an empty object for a zero-length payload', () => {
    // When
    const result = captureBodyAttribute('orders.created', new Uint8Array(), { maxBytes: 1024 });

    // Then
    expect(result).toEqual({});
  });

  it('should decode UTF-8 payloads as text', () => {
    // Given
    const text = JSON.stringify({ id: faker.string.uuid() });
    const payload = new TextEncoder().encode(text);

    // When
    const result = captureBodyAttribute('orders.created', payload, { maxBytes: 1024 });

    // Then
    expect(result['messaging.nats.message.body']).toBe(text);
    expect(result['messaging.nats.message.body.truncated']).toBeUndefined();
  });

  it('should substitute U+FFFD for invalid UTF-8 bytes instead of dropping the whole attribute', () => {
    // Given — bytes that do not form a valid UTF-8 sequence.
    const payload = new Uint8Array([0xff, 0xfe, 0xfd]);

    // When
    const result = captureBodyAttribute('orders.created', payload, { maxBytes: 1024 });

    // Then — `fatal: false` in `TextDecoder` renders the bad bytes as U+FFFD
    // so operators still get some signal in APM instead of a silent base64
    // fallback that's hard to recognise visually.
    expect(result['messaging.nats.message.body']).toBe('���');
  });

  it('should decode UTF-8 payloads truncated mid-codepoint without collapsing to base64', () => {
    // Given — a multi-byte UTF-8 char (😀 = F0 9F 98 80) clipped after 2 bytes.
    const payload = new Uint8Array([0xf0, 0x9f]);

    // When
    const result = captureBodyAttribute('orders.created', payload, { maxBytes: 1024 });

    // Then — trailing replacement char, not base64
    expect(result['messaging.nats.message.body']).toBe('�');
  });

  it('should truncate payloads exceeding maxBytes and flag truncated=true', () => {
    // Given
    const text = 'a'.repeat(10);
    const payload = new TextEncoder().encode(text);

    // When
    const result = captureBodyAttribute('orders.created', payload, { maxBytes: 4 });

    // Then
    expect(result['messaging.nats.message.body']).toBe('aaaa');
    expect(result['messaging.nats.message.body.truncated']).toBe(true);
  });

  it('should skip capture when subject is outside the allowlist', () => {
    // Given
    const payload = new TextEncoder().encode('hi');

    // When
    const result = captureBodyAttribute('inventory.updated', payload, {
      maxBytes: 1024,
      subjectAllowlist: ['orders.*'],
    });

    // Then
    expect(result).toEqual({});
  });
});
