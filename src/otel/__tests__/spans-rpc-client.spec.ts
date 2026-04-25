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

import { resolveOtelOptions } from '../config';
import {
  RPC_TIMEOUT_MESSAGE,
  RpcOutcomeKind,
  beginRpcClientSpan,
  type RpcClientSpanContext,
} from '../spans/rpc-client';
import { JetstreamTrace } from '../trace-kinds';

const baseCtx = (): RpcClientSpanContext => ({
  subject: faker.lorem.slug(),
  payloadBytes: 0,
  payload: new Uint8Array(),
  headers: headers(),
  serviceName: faker.word.noun(),
  endpoint: { host: faker.internet.ip(), port: 4222 },
});

describe('beginRpcClientSpan', () => {
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
    it('should return a noop handle and skip header injection when enabled is false', () => {
      // Given
      const config = resolveOtelOptions({ enabled: false });
      const ctx = baseCtx();

      // When
      const handle = beginRpcClientSpan(ctx, config);

      handle.finish({ kind: RpcOutcomeKind.Ok, reply: 'ok' });

      // Then
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      expect(ctx.headers.get('traceparent')).toBe('');
    });

    it('should still inject context when the trace kind is filtered out', () => {
      // Given — we need an active span so `traceparent` has something to encode
      const config = resolveOtelOptions({ traces: [JetstreamTrace.Publish] });
      const tracer = trace.getTracer('test');
      const ambient = tracer.startSpan('ambient');
      const ctxWithAmbient = trace.setSpan(context.active(), ambient);
      const ctx = baseCtx();

      // When
      context.with(ctxWithAmbient, () => {
        const handle = beginRpcClientSpan(ctx, config);

        handle.finish({ kind: RpcOutcomeKind.Ok, reply: undefined });
      });

      ambient.end();

      // Then
      expect(exporter.getFinishedSpans().filter((s) => s.name.startsWith('send '))).toHaveLength(0);
      expect(ctx.headers.get('traceparent')).toMatch(/^00-/u);
    });
  });

  describe('outcomes', () => {
    it('should mark Ok outcomes with status OK', () => {
      // Given
      const handle = beginRpcClientSpan(baseCtx(), resolveOtelOptions());

      // When
      handle.finish({ kind: RpcOutcomeKind.Ok, reply: { id: 1 } });

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('should mark ReplyError as OK plus has_error attributes', () => {
      // Given
      const handle = beginRpcClientSpan(baseCtx(), resolveOtelOptions());

      // When
      handle.finish({
        kind: RpcOutcomeKind.ReplyError,
        replyPayload: { code: 'NOT_AUTHORIZED', message: 'denied' },
      });

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes['jetstream.rpc.reply.has_error']).toBe(true);
      expect(span.attributes['jetstream.rpc.reply.error.code']).toBe('NOT_AUTHORIZED');
    });

    it('should mark Timeout with status ERROR and the rpc.timeout event', () => {
      // Given
      const handle = beginRpcClientSpan(baseCtx(), resolveOtelOptions());

      // When
      handle.finish({ kind: RpcOutcomeKind.Timeout });

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe(RPC_TIMEOUT_MESSAGE);
      expect(span.events.some((event) => event.name === RPC_TIMEOUT_MESSAGE)).toBe(true);
    });

    it('should record the exception for transport-level Error outcomes', () => {
      // Given
      const handle = beginRpcClientSpan(baseCtx(), resolveOtelOptions());

      // When
      handle.finish({ kind: RpcOutcomeKind.Error, error: new Error('boom') });

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.some((event) => event.name === 'exception')).toBe(true);
    });

    it('should be idempotent across repeated finish() calls', () => {
      // Given
      const handle = beginRpcClientSpan(baseCtx(), resolveOtelOptions());

      // When — first finish wins, second is a no-op
      handle.finish({ kind: RpcOutcomeKind.Ok, reply: 'first' });
      handle.finish({ kind: RpcOutcomeKind.Error, error: new Error('late') });

      // Then
      const finished = exporter.getFinishedSpans();

      expect(finished).toHaveLength(1);
      expect(finished[0]!.status.code).toBe(SpanStatusCode.OK);
    });
  });

  describe('hooks', () => {
    it('should invoke responseHook with the CLIENT span as the active span', () => {
      // Given
      let activeWhenHookFires = trace.getSpan(context.active());
      const config = resolveOtelOptions({
        responseHook: () => {
          activeWhenHookFires = trace.getSpan(context.active());
        },
      });
      const handle = beginRpcClientSpan(baseCtx(), config);

      // When
      handle.finish({ kind: RpcOutcomeKind.Ok, reply: 'ok' });

      // Then
      const span = exporter.getFinishedSpans()[0]!;

      expect(activeWhenHookFires?.spanContext().spanId).toBe(span.spanContext().spanId);
    });
  });
});
