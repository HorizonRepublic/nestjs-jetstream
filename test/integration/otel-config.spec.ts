import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import {
  ClientProxy,
  EventPattern,
  MessagePattern,
  Payload,
  RpcException,
} from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { type NatsConnection } from '@nats-io/transport-node';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { getClientToken, internalName, StreamKind, type OtelOptions } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class ConfigController {
  public readonly received: unknown[] = [];

  @EventPattern('orders.created')
  handleEvent(@Payload() data: unknown): void {
    this.received.push(data);
  }

  @MessagePattern('orders.lookup')
  handleRpc(@Payload() data: { readonly id: string }): { readonly ok: true; readonly id: string } {
    return { ok: true, id: data.id };
  }

  @MessagePattern('orders.deny')
  failBusiness(): never {
    throw new RpcException({ code: 'NOT_AUTHORIZED' });
  }
}

interface PublisherSetup {
  readonly app: INestApplication;
  readonly client: ClientProxy;
}

/**
 * Bootstrap two separate apps: a "server-side" one that owns the JetStream
 * streams + consumers (so publishes from the publisher side actually have
 * somewhere to land) and a "client-side" one that is publisher-only and
 * carries the OTel config under test. Returns both so each test can drive
 * the publisher and inspect the consumer outcome.
 */
const bootstrapPair = async (
  port: number,
  publisherOtel: OtelOptions,
  serverOtel: OtelOptions = {},
  rpcMode: 'core' | undefined = undefined,
): Promise<{
  serverApp: INestApplication;
  serverModule: TestingModule;
  serverController: ConfigController;
  serverServiceName: string;
  publisher: PublisherSetup;
  publisherServiceName: string;
}> => {
  const serverServiceName = uniqueServiceName();
  const { app: serverApp, module: serverModule } = await createTestApp(
    {
      name: serverServiceName,
      port,
      otel: serverOtel,
      ...(rpcMode ? { rpc: { mode: rpcMode } } : {}),
    },
    [ConfigController],
    [],
  );

  const publisherServiceName = uniqueServiceName();
  const { app: publisherApp, module: publisherModule } = await createTestApp(
    {
      name: publisherServiceName,
      port,
      consumer: false,
      otel: publisherOtel,
      ...(rpcMode ? { rpc: { mode: rpcMode } } : {}),
    },
    [],
    [serverServiceName],
  );

  return {
    serverApp,
    serverModule,
    serverController: serverModule.get(ConfigController),
    serverServiceName,
    publisher: {
      app: publisherApp,
      client: publisherModule.get<ClientProxy>(getClientToken(serverServiceName)),
    },
    publisherServiceName,
  };
};

describe('OTel config integration — kill switch, propagation-only, hooks', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);

    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  }, 60_000);

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    propagation.disable();
    context.disable();
    try {
      await nc.drain();
    } finally {
      await container.stop();
    }
  });

  afterEach(() => {
    exporter.reset();
  });

  describe('kill switch — otel.enabled: false', () => {
    it('should produce zero spans across the full publish + consume + RPC flow', async () => {
      // Given — both sides disabled.
      const setup = await bootstrapPair(port, { enabled: false }, { enabled: false }, 'core');

      try {
        // When
        await firstValueFrom(setup.publisher.client.emit('orders.created', { id: 'k1' }));
        await firstValueFrom(setup.publisher.client.send('orders.lookup', { id: 'k2' }));
        await waitForCondition(() => setup.serverController.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then — exporter saw nothing from the library.
        expect(exporter.getFinishedSpans()).toHaveLength(0);
      } finally {
        await setup.publisher.app.close();
        await setup.serverApp.close();
        await cleanupStreams(nc, setup.serverServiceName);
      }
    });

    it('should not inject traceparent into outgoing headers when disabled', async () => {
      // Given — server-side has OTel ON so it can read the inbound headers
      // via its consume span, but the publisher has OTel OFF.
      const setup = await bootstrapPair(port, { enabled: false }, { captureHeaders: true });

      try {
        // When
        await firstValueFrom(setup.publisher.client.emit('orders.created', { id: 'k3' }));
        await waitForCondition(() => setup.serverController.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then — the consume span does not surface a `traceparent` because
        // the publisher never injected one.
        const consume = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.CONSUMER)!;

        expect(consume.attributes['messaging.header.traceparent']).toBeUndefined();

        // The CONSUMER span is also a root span (no parent) for the same reason.
        expect(consume.parentSpanContext).toBeUndefined();
      } finally {
        await setup.publisher.app.close();
        await setup.serverApp.close();
        await cleanupStreams(nc, setup.serverServiceName);
      }
    });
  });

  describe('propagation-only mode — traces: "none"', () => {
    it('should suppress library spans on the publisher but still inject traceparent', async () => {
      // Given — publisher-side spans are off, but propagation is alive.
      const setup = await bootstrapPair(port, { traces: 'none' });

      try {
        const tracer = trace.getTracer('host-app-test');
        const ambient = tracer.startSpan('caller');
        const ambientTraceId = ambient.spanContext().traceId;

        // When
        await context.with(trace.setSpan(context.active(), ambient), () =>
          firstValueFrom(setup.publisher.client.emit('orders.created', { id: 'p1' })),
        );

        ambient.end();
        await waitForCondition(() => setup.serverController.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then — no PRODUCER span on the publisher side.
        const finished = exporter.getFinishedSpans();
        const publisherSpans = finished.filter(
          (s) =>
            s.kind === SpanKind.PRODUCER &&
            s.name.startsWith(`publish ${internalName(setup.serverServiceName)}.`),
        );

        expect(publisherSpans).toHaveLength(0);

        // …but the server-side CONSUMER span is parented under the host
        // trace, proving traceparent flowed across the wire.
        const consume = finished.find((s) => s.kind === SpanKind.CONSUMER)!;

        expect(consume.spanContext().traceId).toBe(ambientTraceId);
      } finally {
        await setup.publisher.app.close();
        await setup.serverApp.close();
        await cleanupStreams(nc, setup.serverServiceName);
      }
    });
  });

  describe('hooks fire end-to-end with the active span context', () => {
    it('should fire publishHook + responseHook with the producer span as the active span', async () => {
      // Given
      const publishHook = vi.fn();
      const responseHook = vi.fn();
      const setup = await bootstrapPair(port, {
        publishHook: (span) => {
          publishHook({
            spanId: span.spanContext().spanId,
            activeSpanId: trace.getSpan(context.active())?.spanContext().spanId,
          });
        },
        responseHook: (span, ctx) => {
          responseHook({
            spanId: span.spanContext().spanId,
            durationMs: ctx.durationMs,
            error: ctx.error?.message,
          });
        },
      });

      try {
        // When
        await firstValueFrom(setup.publisher.client.emit('orders.created', { id: 'h1' }));
        await waitForCondition(() => setup.serverController.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then — publishHook saw producer span as active.
        expect(publishHook).toHaveBeenCalled();
        const publishCall = publishHook.mock.calls[0]![0];

        expect(publishCall.activeSpanId).toBe(publishCall.spanId);

        // responseHook fires once for the publisher PRODUCER span.
        expect(responseHook).toHaveBeenCalled();
        const publisherResponse = responseHook.mock.calls[0]![0];

        expect(publisherResponse.durationMs).toBeGreaterThanOrEqual(0);
        expect(publisherResponse.error).toBeUndefined();
      } finally {
        await setup.publisher.app.close();
        await setup.serverApp.close();
        await cleanupStreams(nc, setup.serverServiceName);
      }
    });

    it('should fire consumeHook on the server side with the consume span as active', async () => {
      // Given — hook lives on the server-side OTel config.
      const consumeHook = vi.fn();
      const setup = await bootstrapPair(
        port,
        {},
        {
          consumeHook: (span, ctx) => {
            consumeHook({
              subject: ctx.subject,
              kind: ctx.kind,
              activeSpanId: trace.getSpan(context.active())?.spanContext().spanId,
              spanId: span.spanContext().spanId,
            });
          },
        },
      );

      try {
        // When
        await firstValueFrom(setup.publisher.client.emit('orders.created', { id: 'h2' }));
        await waitForCondition(() => setup.serverController.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then
        expect(consumeHook).toHaveBeenCalled();
        const call = consumeHook.mock.calls[0]![0];

        expect(call.kind).toBe('event');
        expect(call.activeSpanId).toBe(call.spanId);
      } finally {
        await setup.publisher.app.close();
        await setup.serverApp.close();
        await cleanupStreams(nc, setup.serverServiceName);
      }
    });

    it('should pass the thrown error to responseHook on a failed RPC consume', async () => {
      // Given — Core RPC where the handler throws an RpcException; the
      // default classifier marks it `expected`, so the consume span stays OK
      // but the responseHook still receives `error`.
      const responseHook = vi.fn();
      const setup = await bootstrapPair(
        port,
        {},
        {
          responseHook: (_span, ctx) => {
            responseHook({ subject: ctx.subject, error: ctx.error });
          },
        },
        'core',
      );

      try {
        // When
        await expect(
          firstValueFrom(setup.publisher.client.send('orders.deny', {})),
        ).rejects.toBeDefined();
        await provider.forceFlush();

        // Then
        const consumeCall = responseHook.mock.calls.find((c) =>
          c[0].subject.endsWith('orders.deny'),
        );

        expect(consumeCall).toBeDefined();
        expect(consumeCall![0].error).toBeDefined();
      } finally {
        await setup.publisher.app.close();
        await setup.serverApp.close();
        await cleanupStreams(nc, setup.serverServiceName);
      }
    });
  });

  describe('shouldTrace* predicates', () => {
    it('should skip publisher span creation but keep traceparent injection', async () => {
      // Given — publisher predicate suppresses span; server side stays on
      // and surfaces the traceparent via its CONSUMER span parent linkage.
      const setup = await bootstrapPair(port, { shouldTracePublish: () => false });

      try {
        const tracer = trace.getTracer('host-app-test');
        const ambient = tracer.startSpan('caller');
        const ambientTraceId = ambient.spanContext().traceId;

        // When
        await context.with(trace.setSpan(context.active(), ambient), () =>
          firstValueFrom(setup.publisher.client.emit('orders.created', { id: 's1' })),
        );

        ambient.end();
        await waitForCondition(() => setup.serverController.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then — no PRODUCER span for the publisher's emit.
        const publisherSubject = `publish ${internalName(setup.serverServiceName)}.${StreamKind.Event}.orders.created`;

        expect(
          exporter
            .getFinishedSpans()
            .filter((s) => s.kind === SpanKind.PRODUCER && s.name === publisherSubject),
        ).toHaveLength(0);

        // …but the server-side CONSUMER span still has the host trace as parent.
        const consume = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.CONSUMER)!;

        expect(consume.spanContext().traceId).toBe(ambientTraceId);
      } finally {
        await setup.publisher.app.close();
        await setup.serverApp.close();
        await cleanupStreams(nc, setup.serverServiceName);
      }
    });
  });

  describe('custom errorClassifier', () => {
    it('should override the default classification — every error treated as expected', async () => {
      // Given — server-side classifier marks every error as expected.
      const setup = await bootstrapPair(port, {}, { errorClassifier: () => 'expected' }, 'core');

      try {
        // When
        await expect(
          firstValueFrom(setup.publisher.client.send('orders.deny', {})),
        ).rejects.toBeDefined();
        await provider.forceFlush();

        // Then — consume span has OK + business-error attribute.
        const consume = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.CONSUMER)!;

        expect(consume.status.code).toBe(SpanStatusCode.OK);
        expect(consume.attributes['jetstream.rpc.reply.has_error']).toBe(true);
      } finally {
        await setup.publisher.app.close();
        await setup.serverApp.close();
        await cleanupStreams(nc, setup.serverServiceName);
      }
    });
  });
});
