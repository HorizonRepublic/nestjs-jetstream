import { describe, expect, it } from 'vitest';

import { getTracer } from '../tracer';

describe('getTracer', () => {
  it('should return a tracer (even a no-op one) from `@opentelemetry/api`', () => {
    const sut = getTracer();

    expect(sut).toBeDefined();
    expect(typeof sut.startSpan).toBe('function');
  });

  it('should return the same cached tracer instance on repeated calls', () => {
    expect(getTracer()).toBe(getTracer());
  });
});
