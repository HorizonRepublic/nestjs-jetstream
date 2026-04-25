import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { faker } from '@faker-js/faker';
import { SpanKind, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { headers } from '@nats-io/transport-node';

import { JetstreamRecord } from '../../client';
import { PublishKind, resolveOtelOptions } from '../config';
import { withPublishSpan, type PublishSpanContext } from '../spans/publish';
import { JetstreamTrace } from '../trace-kinds';

const baseCtx = (): PublishSpanContext => ({
  subject: faker.lorem.slug(),
  record: new JetstreamRecord({}, new Map()),
  kind: PublishKind.Event,
  payloadBytes: 0,
  payload: new Uint8Array(),
  headers: headers(),
  serviceName: faker.word.noun(),
  endpoint: { host: faker.internet.ip(), port: 4222 },
});

describe('withPublishSpan', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    propagation.disable();
    context.disable();
  });

  afterEach(() => {
    exporter.reset();
    vi.resetAllMocks();
  });

  describe('fast paths', () => {
    it('should run fn directly with no span and no header injection when enabled is false', async () => {
      // Given
      const config = resolveOtelOptions({ enabled: false });
      const fn = vi.fn().mockResolvedValue('ok');
      const ctx = baseCtx();

      // When
      const result = await withPublishSpan(ctx, config, fn);

      // Then
      expect(result).toBe('ok');
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      expect(ctx.headers.get('traceparent')).toBe('');
    });

    it('should inject ambient context but skip span creation when traces excludes Publish', async () => {
      // Given — register a tracer-provider-emitted active span so injection has something to write
      const config = resolveOtelOptions({ traces: [JetstreamTrace.Consume] });
      const tracer = trace.getTracer('test');
      const ambient = tracer.startSpan('ambient');
      const ctxWithAmbient = trace.setSpan(context.active(), ambient);
      const ctx = baseCtx();

      // When
      await context.with(ctxWithAmbient, () => withPublishSpan(ctx, config, async () => undefined));
      ambient.end();

      // Then
      expect(exporter.getFinishedSpans().filter((s) => s.name.startsWith('publish '))).toHaveLength(
        0,
      );
      expect(ctx.headers.get('traceparent')).toMatch(/^00-/u);
    });

    it('should fail-open and still create a span when shouldTracePublish throws', async () => {
      // Given
      const config = resolveOtelOptions({
        shouldTracePublish: () => {
          throw new Error('predicate exploded');
        },
      });

      // When + Then — publish path must not propagate the predicate failure.
      await expect(withPublishSpan(baseCtx(), config, async () => 'ok')).resolves.toBe('ok');

      const spans = exporter.getFinishedSpans().filter((s) => s.name.startsWith('publish '));

      expect(spans).toHaveLength(1);
    });
  });

  describe('happy path', () => {
    it('should produce a PRODUCER span with status OK and inject traceparent into headers', async () => {
      // Given
      const config = resolveOtelOptions();
      const ctx = baseCtx();

      // When
      await withPublishSpan(ctx, config, async () => undefined);

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.kind).toBe(SpanKind.PRODUCER);
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(ctx.headers.get('traceparent')).toMatch(/^00-/u);
    });
  });

  describe('error path', () => {
    it('should record span exceptions and rethrow when fn rejects', async () => {
      // Given
      const config = resolveOtelOptions();
      const error = new Error(faker.lorem.sentence());

      // When
      await expect(
        withPublishSpan(baseCtx(), config, async () => {
          throw error;
        }),
      ).rejects.toThrow(error.message);

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.some((event) => event.name === 'exception')).toBe(true);
    });
  });

  describe('hooks', () => {
    it('should invoke publishHook with the producer span set as the active span', async () => {
      // Given
      let activeWhenHookFires = trace.getSpan(context.active());
      const config = resolveOtelOptions({
        publishHook: () => {
          activeWhenHookFires = trace.getSpan(context.active());
        },
      });

      // When
      await withPublishSpan(baseCtx(), config, async () => undefined);

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(activeWhenHookFires?.spanContext().spanId).toBe(span.spanContext().spanId);
    });

    it('should swallow async hook rejections without leaking unhandled rejections', async () => {
      // Given
      const config = resolveOtelOptions({
        publishHook: (() => Promise.reject(new Error('bad hook'))) as unknown as Parameters<
          typeof resolveOtelOptions
        >[0] extends infer Opts
          ? Opts extends { publishHook?: infer H }
            ? H
            : never
          : never,
      });

      // When + Then
      await expect(withPublishSpan(baseCtx(), config, async () => 'ok')).resolves.toBe('ok');
    });
  });
});
