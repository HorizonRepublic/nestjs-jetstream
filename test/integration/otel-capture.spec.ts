import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { NatsConnection } from '@nats-io/transport-node';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { getClientToken, JetstreamRecordBuilder, type OtelOptions } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class CaptureController {
  public readonly received: unknown[] = [];

  @EventPattern('orders.created')
  handle(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

describe('OTel header / body capture integration', () => {
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

  const bootstrap = async (
    otel: OtelOptions,
  ): Promise<{
    app: INestApplication;
    client: ClientProxy;
    controller: CaptureController;
    serviceName: string;
  }> => {
    const serviceName = uniqueServiceName();
    const { app, module } = await createTestApp(
      { name: serviceName, port, otel },
      [CaptureController],
      [serviceName],
    );

    return {
      app,
      client: module.get<ClientProxy>(getClientToken(serviceName)),
      controller: module.get(CaptureController),
      serviceName,
    };
  };

  describe('header capture', () => {
    it('should expose allowlisted headers as messaging.header.<name> attributes on both spans', async () => {
      // Given — explicit allowlist with a wildcard so user-defined `x-*`
      // headers flow through, plus an exact entry.
      const { app, client, controller, serviceName } = await bootstrap({
        captureHeaders: ['x-tenant-id', 'x-trace-*'],
      });

      try {
        const record = new JetstreamRecordBuilder({ id: 'h1' })
          .setHeader('x-tenant-id', 'acme')
          .setHeader('x-trace-flow', 'demo')
          .build();

        // When
        await firstValueFrom(client.emit('orders.created', record));
        await waitForCondition(() => controller.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then
        const spans = exporter.getFinishedSpans();
        const publish = spans.find((s) => s.kind === SpanKind.PRODUCER)!;
        const consume = spans.find((s) => s.kind === SpanKind.CONSUMER)!;

        expect(publish.attributes['messaging.header.x-tenant-id']).toBe('acme');
        expect(publish.attributes['messaging.header.x-trace-flow']).toBe('demo');
        expect(consume.attributes['messaging.header.x-tenant-id']).toBe('acme');
        expect(consume.attributes['messaging.header.x-trace-flow']).toBe('demo');
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should never emit propagator-owned or library-internal headers as messaging.header.* even with captureHeaders=true', async () => {
      // Given — `true` matches every header, so the only thing that can
      // suppress a key is the explicit denylist inside `captureMatchingHeaders`.
      const { app, client, controller, serviceName } = await bootstrap({
        captureHeaders: true,
      });

      try {
        const record = new JetstreamRecordBuilder({ id: 'h2' })
          .setHeader('x-tenant-id', 'acme') // legit user header — should appear
          .build();

        // When
        await firstValueFrom(client.emit('orders.created', record));
        await waitForCondition(() => controller.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then — privacy-sensitive headers must not leak.
        const spans = exporter.getFinishedSpans();

        for (const span of spans) {
          for (const denied of [
            'messaging.header.traceparent',
            'messaging.header.tracestate',
            'messaging.header.baggage',
            'messaging.header.x-correlation-id',
            'messaging.header.x-reply-to',
            'messaging.header.x-error',
            'messaging.header.x-subject',
            'messaging.header.x-caller-name',
            'messaging.header.nats-msg-id',
          ]) {
            expect(span.attributes[denied]).toBeUndefined();
          }
        }

        // Sanity — legit user header still surfaces.
        const consume = spans.find((s) => s.kind === SpanKind.CONSUMER)!;

        expect(consume.attributes['messaging.header.x-tenant-id']).toBe('acme');
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should default to capturing only x-request-id when captureHeaders is omitted', async () => {
      // Given — no captureHeaders override → default `['x-request-id']`.
      const { app, client, controller, serviceName } = await bootstrap({});

      try {
        const record = new JetstreamRecordBuilder({ id: 'h3' })
          .setHeader('x-request-id', 'req-123')
          .setHeader('x-tenant-id', 'acme') // present on wire but not allowlisted
          .build();

        // When
        await firstValueFrom(client.emit('orders.created', record));
        await waitForCondition(() => controller.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then
        const consume = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.CONSUMER)!;

        expect(consume.attributes['messaging.header.x-request-id']).toBe('req-123');
        expect(consume.attributes['messaging.header.x-tenant-id']).toBeUndefined();
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });
  });

  describe('body capture', () => {
    it('should attach the decoded payload as messaging.nats.message.body when enabled', async () => {
      // Given
      const { app, client, controller, serviceName } = await bootstrap({
        captureBody: true,
      });

      try {
        const payload = { id: 'b1', items: ['widget-a', 'widget-b'] };

        // When
        await firstValueFrom(client.emit('orders.created', payload));
        await waitForCondition(() => controller.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then — both publish and consume capture the same payload.
        const spans = exporter.getFinishedSpans();
        const publish = spans.find((s) => s.kind === SpanKind.PRODUCER)!;
        const consume = spans.find((s) => s.kind === SpanKind.CONSUMER)!;
        const expected = JSON.stringify(payload);

        expect(publish.attributes['messaging.nats.message.body']).toBe(expected);
        expect(consume.attributes['messaging.nats.message.body']).toBe(expected);
        expect(publish.attributes['messaging.nats.message.body.truncated']).toBeUndefined();
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should truncate payloads exceeding maxBytes and flag body.truncated=true', async () => {
      // Given — small maxBytes so any normal payload overflows.
      const { app, client, controller, serviceName } = await bootstrap({
        captureBody: { maxBytes: 32 },
      });

      try {
        const payload = { id: 'b2', filler: 'x'.repeat(200) };

        // When
        await firstValueFrom(client.emit('orders.created', payload));
        await waitForCondition(() => controller.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then
        const consume = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.CONSUMER)!;

        const captured = consume.attributes['messaging.nats.message.body'] as string;

        expect(captured.length).toBe(32);
        expect(consume.attributes['messaging.nats.message.body.truncated']).toBe(true);
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should respect subjectAllowlist — body captured only for matching subjects', async () => {
      // Given — allowlist excludes `orders.*` so this publish must NOT
      // produce a body attribute.
      const { app, client, controller, serviceName } = await bootstrap({
        captureBody: { maxBytes: 4096, subjectAllowlist: ['payments.*'] },
      });

      try {
        // When
        await firstValueFrom(client.emit('orders.created', { id: 'b3' }));
        await waitForCondition(() => controller.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then
        const spans = exporter.getFinishedSpans();

        for (const span of spans) {
          expect(span.attributes['messaging.nats.message.body']).toBeUndefined();
        }
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should default to false (no body attribute) when captureBody is omitted', async () => {
      // Given
      const { app, client, controller, serviceName } = await bootstrap({});

      try {
        // When
        await firstValueFrom(client.emit('orders.created', { id: 'b4' }));
        await waitForCondition(() => controller.received.length === 1, 5_000);
        await provider.forceFlush();

        // Then
        const spans = exporter.getFinishedSpans();

        for (const span of spans) {
          expect(span.attributes['messaging.nats.message.body']).toBeUndefined();
        }
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });
  });
});
