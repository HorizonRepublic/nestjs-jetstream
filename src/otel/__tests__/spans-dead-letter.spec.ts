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
import type { JsMsg } from '@nats-io/jetstream';
import { createMock } from '@golevelup/ts-vitest';

import { resolveOtelOptions } from '../config';
import { withDeadLetterSpan, type DeadLetterSpanContext } from '../spans/dead-letter';
import { JetstreamTrace } from '../trace-kinds';

const baseCtx = (): DeadLetterSpanContext => ({
  msg: createMock<JsMsg>({
    subject: faker.lorem.slug(),
    headers: headers(),
  }),
  finalDeliveryCount: 3,
  reason: faker.lorem.sentence(),
  serviceName: faker.word.noun(),
  endpoint: { host: faker.internet.ip(), port: 4222 },
});

describe('withDeadLetterSpan', () => {
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

  describe('toggle gating', () => {
    it('should run fn directly when DeadLetter trace is off', async () => {
      // Given — DeadLetter is part of DEFAULT_TRACES, so disable explicitly
      const config = resolveOtelOptions({ traces: [JetstreamTrace.Publish] });
      const fn = vi.fn().mockResolvedValue('ok');

      // When
      const result = await withDeadLetterSpan(baseCtx(), config, fn);

      // Then
      expect(result).toBe('ok');
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    });

    it('should skip span creation when otel.enabled is false', async () => {
      // Given
      const config = resolveOtelOptions({ enabled: false });

      // When
      await withDeadLetterSpan(baseCtx(), config, async () => undefined);

      // Then
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    });
  });

  describe('happy path', () => {
    it('should produce an INTERNAL span with status OK on successful fallback', async () => {
      // Given
      const config = resolveOtelOptions();

      // When
      await withDeadLetterSpan(baseCtx(), config, async () => undefined);

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.kind).toBe(SpanKind.INTERNAL);
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });
  });

  describe('error path', () => {
    it('should record exceptions and rethrow when fn rejects', async () => {
      // Given
      const config = resolveOtelOptions();
      const error = new Error(faker.lorem.sentence());

      // When
      await expect(
        withDeadLetterSpan(baseCtx(), config, async () => {
          throw error;
        }),
      ).rejects.toThrow(error.message);

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.some((event) => event.name === 'exception')).toBe(true);
    });

    it('should wrap non-Error throws into an Error before recording the exception', async () => {
      // Given
      const config = resolveOtelOptions();

      // When
      await expect(
        withDeadLetterSpan(baseCtx(), config, async () => {
          throw 'string failure';
        }),
      ).rejects.toBeDefined();

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('string failure');
    });
  });

  describe('hooks', () => {
    it('should run responseHook with the dead-letter span as the active span', async () => {
      // Given
      let activeWhenHookFires = trace.getSpan(context.active());
      const config = resolveOtelOptions({
        responseHook: () => {
          activeWhenHookFires = trace.getSpan(context.active());
        },
      });

      // When
      await withDeadLetterSpan(baseCtx(), config, async () => undefined);

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(activeWhenHookFires?.spanContext().spanId).toBe(span.spanContext().spanId);
    });
  });
});
