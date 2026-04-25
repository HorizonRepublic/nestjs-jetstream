import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ROOT_CONTEXT,
  propagation,
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from '@opentelemetry/api';

import { extractContext, injectContext } from '../propagator';

describe('propagator', () => {
  afterEach(() => {
    propagation.disable();
    vi.restoreAllMocks();
  });

  describe('without a registered global propagator', () => {
    beforeEach(() => {
      // `propagation.disable()` reverts the global back to the no-op
      // propagator shipped inside `@opentelemetry/api`.
      propagation.disable();
    });

    it('injectContext should leave the carrier untouched (global noop)', () => {
      // Given
      const carrier: Record<string, string> = {};
      const setter: TextMapSetter<Record<string, string>> = {
        set: (c, k, v) => {
          c[k] = v;
        },
      };

      // When
      injectContext(ROOT_CONTEXT, carrier, setter);

      // Then — library does NOT ship its own fallback propagator; if the
      // host app hasn't registered an SDK there is nothing to propagate.
      expect(carrier).toEqual({});
    });

    it('extractContext should return the input context unchanged', () => {
      // Given
      const carrier = { traceparent: '00-aaaa-bbbb-01' };
      const getter: TextMapGetter<typeof carrier> = {
        keys: (c) => Object.keys(c),
        get: (c, k) => c[k as keyof typeof carrier],
      };

      // When
      const result = extractContext(ROOT_CONTEXT, carrier, getter);

      // Then — no propagator to read headers with, ROOT_CONTEXT passes through
      expect(result).toBe(ROOT_CONTEXT);
    });
  });

  describe('with a registered global propagator', () => {
    it('injectContext delegates to the global propagator', () => {
      // Given
      const injectSpy = vi.fn();
      const fake: TextMapPropagator = {
        inject: injectSpy,
        extract: (ctx: Context) => ctx,
        fields: () => ['traceparent'],
      };

      propagation.setGlobalPropagator(fake);

      const carrier = {};
      const setter: TextMapSetter<typeof carrier> = { set: vi.fn() };

      // When
      injectContext(ROOT_CONTEXT, carrier, setter);

      // Then
      expect(injectSpy).toHaveBeenCalledWith(ROOT_CONTEXT, carrier, setter);
    });

    it('extractContext delegates to the global propagator', () => {
      // Given
      const extractSpy = vi.fn((ctx: Context) => ctx);
      const fake: TextMapPropagator = {
        inject: vi.fn(),
        extract: extractSpy,
        fields: () => ['traceparent'],
      };

      propagation.setGlobalPropagator(fake);

      const carrier = {};
      const getter: TextMapGetter<typeof carrier> = {
        keys: () => [],
        get: () => undefined,
      };

      // When
      extractContext(ROOT_CONTEXT, carrier, getter);

      // Then
      expect(extractSpy).toHaveBeenCalledWith(ROOT_CONTEXT, carrier, getter);
    });
  });
});
