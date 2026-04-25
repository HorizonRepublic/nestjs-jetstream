import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { faker } from '@faker-js/faker';
import { SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { headers } from '@nats-io/transport-node';

import { ConsumeKind, resolveOtelOptions } from '../config';
import { withConsumeSpan, type ConsumeSpanContext } from '../spans/consume';
import { JetstreamTrace } from '../trace-kinds';

const baseCtx = (): ConsumeSpanContext => ({
  subject: faker.lorem.slug(),
  msg: { subject: faker.lorem.slug(), data: new Uint8Array(), headers: headers() },
  kind: ConsumeKind.Event,
  payloadBytes: 0,
  handlerMetadata: { pattern: faker.lorem.slug() },
  serviceName: faker.word.noun(),
  endpoint: { host: faker.internet.ip(), port: 4222 },
});

describe('withConsumeSpan', () => {
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
    it('should run fn directly without creating a span when enabled is false', async () => {
      // Given
      const config = resolveOtelOptions({ enabled: false });
      const fn = vi.fn().mockReturnValue('result');

      // When
      const result = await withConsumeSpan(baseCtx(), config, fn);

      // Then
      expect(result).toBe('result');
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      expect(fn).toHaveBeenCalledOnce();
    });

    it('should skip span creation when traces excludes Consume but still run fn under extracted parent', async () => {
      // Given
      const config = resolveOtelOptions({ traces: [JetstreamTrace.Publish] });
      const fn = vi.fn().mockReturnValue('result');

      // When
      const result = await withConsumeSpan(baseCtx(), config, fn);

      // Then
      expect(result).toBe('result');
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    });

    it('should skip span creation when shouldTraceConsume returns false', async () => {
      // Given
      const config = resolveOtelOptions({ shouldTraceConsume: () => false });
      const fn = vi.fn().mockReturnValue('ok');

      // When
      await withConsumeSpan(baseCtx(), config, fn);

      // Then
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    });
  });

  describe('happy path', () => {
    it('should produce an OK span for a synchronous handler', async () => {
      // Given
      const config = resolveOtelOptions();
      const fn = vi.fn().mockReturnValue('sync');

      // When
      const result = withConsumeSpan(baseCtx(), config, fn);

      // Then — sync return preserved
      expect(result).toBe('sync');

      const span = exporter.getFinishedSpans()[0]!;

      expect(span.name).toMatch(/^process /u);
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('should produce an OK span for an async handler that resolves', async () => {
      // Given
      const config = resolveOtelOptions();

      // When
      const result = await withConsumeSpan(baseCtx(), config, async () => 'async');

      // Then
      expect(result).toBe('async');

      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.OK);
    });
  });

  describe('error paths', () => {
    it('should record sync throws as ERROR via the unexpected branch by default', () => {
      // Given
      const config = resolveOtelOptions();
      const sut = (): unknown =>
        withConsumeSpan(baseCtx(), config, () => {
          throw new Error('boom');
        });

      // When + Then
      expect(sut).toThrow('boom');

      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.some((event) => event.name === 'exception')).toBe(true);
    });

    it('should mark async handler rejection as ERROR by default', async () => {
      // Given
      const config = resolveOtelOptions();
      const error = new Error(faker.lorem.sentence());

      // When
      await expect(
        withConsumeSpan(baseCtx(), config, async () => {
          throw error;
        }),
      ).rejects.toThrow(error.message);

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });

    it('should classify expected errors as OK + has_error attribute', async () => {
      // Given
      const config = resolveOtelOptions({ errorClassifier: () => 'expected' });

      // When
      await expect(
        withConsumeSpan(baseCtx(), config, async () => {
          throw { code: 'NOT_AUTHORIZED', message: 'denied' };
        }),
      ).rejects.toBeDefined();

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes['jetstream.rpc.reply.has_error']).toBe(true);
      expect(span.attributes['jetstream.rpc.reply.error.code']).toBe('NOT_AUTHORIZED');
    });
  });

  describe('abort signal', () => {
    it('should finalize the span immediately when the signal is already aborted', async () => {
      // Given
      const config = resolveOtelOptions();
      const controller = new AbortController();

      controller.abort();

      // When — `fn` still runs per the documented contract; span is already
      // closed by the time the handler returns and any settlement is a no-op.
      await withConsumeSpan(baseCtx(), config, async () => 'late', {
        signal: controller.signal,
        timeoutLabel: 'rpc.handler.timeout',
      });

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.some((event) => event.name === 'rpc.handler.timeout')).toBe(true);
    });

    it('should detach the abort listener once the handler resolves', async () => {
      // Given — long-lived signal that never aborts; we just verify the
      // listener was removed so a many-consume process doesn't accumulate
      // closures.
      const config = resolveOtelOptions();
      const controller = new AbortController();
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

      // When
      await withConsumeSpan(baseCtx(), config, async () => 'ok', {
        signal: controller.signal,
      });

      // Then
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('should ignore late handler resolution after the span has been aborted', async () => {
      // Given
      const config = resolveOtelOptions();
      const controller = new AbortController();
      let resolveFn: (value: string) => void = (_value) => undefined;
      const handlerSettled = new Promise<string>((resolve) => {
        resolveFn = resolve;
      });

      // When — abort fires before the handler settles; later resolution
      // must not flip the span back to OK.
      const consumePromise = withConsumeSpan(baseCtx(), config, () => handlerSettled, {
        signal: controller.signal,
        timeoutLabel: 'rpc.handler.timeout',
      });

      controller.abort();
      resolveFn('late');
      await consumePromise;

      // Then — only the abort path produced a finished span.
      const finished = exporter.getFinishedSpans();

      expect(finished).toHaveLength(1);
      expect(finished[0]!.status.code).toBe(SpanStatusCode.ERROR);
    });

    it('should ignore late handler rejection after the span has been aborted', async () => {
      // Given
      const config = resolveOtelOptions();
      const controller = new AbortController();
      let rejectFn: (err: unknown) => void = (_err) => undefined;
      const handlerSettled = new Promise<string>((_, reject) => {
        rejectFn = reject;
      });

      // When — abort wins, late rejection must not flip status or fire a
      // second responseHook (covers `finishError`'s `finalized` guard).
      const consumePromise = withConsumeSpan(baseCtx(), config, () => handlerSettled, {
        signal: controller.signal,
        timeoutLabel: 'rpc.handler.timeout',
      });

      controller.abort();
      rejectFn(new Error('late failure'));
      await expect(consumePromise).rejects.toThrow('late failure');

      // Then — single span recorded by the abort path.
      const finished = exporter.getFinishedSpans();

      expect(finished).toHaveLength(1);
      expect(finished[0]!.events.some((event) => event.name === 'rpc.handler.timeout')).toBe(true);
    });
  });

  describe('hooks', () => {
    it('should invoke consumeHook with the active span set as the current context', async () => {
      // Given
      let activeWhenHookFires = trace.getSpan(context.active());
      const config = resolveOtelOptions({
        consumeHook: () => {
          activeWhenHookFires = trace.getSpan(context.active());
        },
      });

      // When
      await withConsumeSpan(baseCtx(), config, async () => 'ok');

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(activeWhenHookFires?.spanContext().spanId).toBe(span.spanContext().spanId);
    });

    it('should swallow async hook rejections without leaking unhandled rejections', async () => {
      // Given
      const config = resolveOtelOptions({
        consumeHook: (() =>
          Promise.reject(new Error('bad hook'))) as unknown as typeof resolveOtelOptions extends (
          opts?: infer O,
        ) => unknown
          ? O extends { consumeHook?: infer H }
            ? H
            : never
          : never,
      });

      // When + Then — must not throw, span still finalizes.
      await expect(withConsumeSpan(baseCtx(), config, async () => 'ok')).resolves.toBe('ok');
    });
  });
});
