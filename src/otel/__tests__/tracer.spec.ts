import { afterEach, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { getTracer } from '../tracer';

describe('getTracer', () => {
  afterEach(() => {
    trace.disable();
  });

  it('should return a tracer (even a no-op one) from `@opentelemetry/api`', () => {
    const sut = getTracer();

    expect(sut).toBeDefined();
    expect(typeof sut.startSpan).toBe('function');
  });

  it('should reflect a TracerProvider registered after first resolution', () => {
    // Given — first call before any provider is registered returns a no-op.
    const before = getTracer();
    const beforeSpan = before.startSpan('warm-up');

    beforeSpan.end();

    // When — host app registers an SDK afterwards (Sentry, NodeSDK, etc.).
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    trace.setGlobalTracerProvider(provider);

    const after = getTracer();
    const afterSpan = after.startSpan('post-register');

    afterSpan.end();

    // Then — the second tracer is bound to the live provider, so spans
    // actually reach the exporter (no stale no-op cache).
    expect(exporter.getFinishedSpans().some((span) => span.name === 'post-register')).toBe(true);
  });
});
