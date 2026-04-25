import { describe, expect, it } from 'vitest';
import { faker } from '@faker-js/faker';
import { headers as natsHeaders } from '@nats-io/transport-node';

import { hdrsGetter, hdrsSetter } from '../carrier';

describe('hdrsSetter', () => {
  it('should write a value into MsgHdrs that hdrsGetter can read back', () => {
    // Given
    const hdrs = natsHeaders();
    const key = `x-${faker.lorem.word()}`;
    const value = faker.string.uuid();

    // When
    hdrsSetter.set(hdrs, key, value);

    // Then
    expect(hdrsGetter.get(hdrs, key)).toBe(value);
  });

  it('should replace prior values rather than appending', () => {
    // Given
    const hdrs = natsHeaders();

    hdrsSetter.set(hdrs, 'traceparent', 'old');

    // When
    hdrsSetter.set(hdrs, 'traceparent', 'new');

    // Then
    expect(hdrsGetter.get(hdrs, 'traceparent')).toBe('new');
  });
});

describe('hdrsGetter', () => {
  it('should return undefined when headers themselves are undefined', () => {
    // When + Then
    expect(hdrsGetter.get(undefined, 'traceparent')).toBeUndefined();
    expect(hdrsGetter.keys(undefined)).toEqual([]);
  });

  it('should normalize an empty-string return from MsgHdrs.get to undefined', () => {
    // Given
    const hdrs = natsHeaders();

    // When + Then — MsgHdrs.get returns '' for missing keys
    expect(hdrsGetter.get(hdrs, 'never-set')).toBeUndefined();
  });

  it('should expose every set key via keys()', () => {
    // Given
    const hdrs = natsHeaders();

    hdrsSetter.set(hdrs, 'traceparent', 'a');
    hdrsSetter.set(hdrs, 'tracestate', 'b');

    // When
    const keys = hdrsGetter.keys(hdrs);

    // Then
    expect(keys).toEqual(expect.arrayContaining(['traceparent', 'tracestate']));
  });

  it('should comma-join multi-valued headers (W3C baggage/tracestate convention)', () => {
    // Given — NATS headers permit multiple values under one key via append().
    const hdrs = natsHeaders();

    hdrs.append('baggage', 'tenant=acme');
    hdrs.append('baggage', 'region=eu');

    // When
    const joined = hdrsGetter.get(hdrs, 'baggage');

    // Then — both entries survive, joined with `,` per the W3C list-header
    // grammar so composite propagators don't silently drop baggage items.
    expect(joined).toBe('tenant=acme,region=eu');
  });

  it('should fall back to get() when carrier has no values() method', () => {
    // Given — a partial test double (shape of createMock<JsMsg>().headers)
    const fakeCarrier = {
      keys: (): string[] => ['traceparent'],
      get: (key: string): string => (key === 'traceparent' ? 'partial' : ''),
    } as unknown as Parameters<typeof hdrsGetter.get>[0];

    // When
    const result = hdrsGetter.get(fakeCarrier, 'traceparent');

    // Then — values() absent → falls back to single-value get() path
    expect(result).toBe('partial');
  });

  it('should return undefined when values() yields an empty array', () => {
    // Given — `values(key)` may return `[]` for keys that exist but were
    // appended with no value (rare, but a real carrier shape).
    const fakeCarrier = {
      keys: (): string[] => ['traceparent'],
      get: (): string => '',
      values: (): string[] => [],
    } as unknown as Parameters<typeof hdrsGetter.get>[0];

    // When + Then
    expect(hdrsGetter.get(fakeCarrier, 'traceparent')).toBeUndefined();
  });

  it('should return undefined when joined values are an empty string', () => {
    // Given — single-entry array containing an empty string
    // (`[''].join(',') === ''`). Treat as missing per the W3C convention.
    const fakeCarrier = {
      keys: (): string[] => ['baggage'],
      get: (): string => '',
      values: (): string[] => [''],
    } as unknown as Parameters<typeof hdrsGetter.get>[0];

    // When + Then
    expect(hdrsGetter.get(fakeCarrier, 'baggage')).toBeUndefined();
  });

  it('should return undefined when every entry in a multi-value array is empty', () => {
    // Given — `['', ''].join(',') === ','` would otherwise leak a stray
    // comma to the propagator. Filter empties before joining.
    const fakeCarrier = {
      keys: (): string[] => ['baggage'],
      get: (): string => '',
      values: (): string[] => ['', ''],
    } as unknown as Parameters<typeof hdrsGetter.get>[0];

    // When + Then
    expect(hdrsGetter.get(fakeCarrier, 'baggage')).toBeUndefined();
  });

  it('should drop empty entries when joining a partially-empty array', () => {
    // Given — only the non-empty entry survives.
    const fakeCarrier = {
      keys: (): string[] => ['baggage'],
      get: (): string => '',
      values: (): string[] => ['', 'tenant=acme'],
    } as unknown as Parameters<typeof hdrsGetter.get>[0];

    // When + Then
    expect(hdrsGetter.get(fakeCarrier, 'baggage')).toBe('tenant=acme');
  });
});
