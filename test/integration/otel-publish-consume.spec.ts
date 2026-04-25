import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import type { NatsConnection } from '@nats-io/transport-node';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { getClientToken, JetstreamTrace } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class OrdersController {
  public readonly received: unknown[] = [];

  @EventPattern('orders.created')
  handle(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

describe('OTel publish + consume integration', () => {
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
  });

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

  describe('event flow', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: OrdersController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      ({ app, module } = await createTestApp(
        { name: serviceName, port },
        [OrdersController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(OrdersController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should emit a PRODUCER span on publish and a CONSUMER span on delivery, linked by traceparent', async () => {
      // When
      await firstValueFrom(client.emit('orders.created', { orderId: 'order-1' }));
      await waitForCondition(() => controller.received.length === 1, 5_000);
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const publish = spans.find((s) => s.kind === SpanKind.PRODUCER);
      const consume = spans.find((s) => s.kind === SpanKind.CONSUMER);

      // Then
      expect(publish).toBeDefined();
      expect(consume).toBeDefined();
      expect(publish!.name).toMatch(/^publish /);
      expect(consume!.name).toMatch(/^process /);
      expect(consume!.spanContext().traceId).toBe(publish!.spanContext().traceId);
      expect(consume!.parentSpanContext?.spanId).toBe(publish!.spanContext().spanId);
    });

    it('should set required messaging attributes on both publish and consume spans', async () => {
      // When
      await firstValueFrom(client.emit('orders.created', { orderId: 'order-2' }));
      await waitForCondition(() => controller.received.length === 1, 5_000);
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const publish = spans.find((s) => s.kind === SpanKind.PRODUCER)!;
      const consume = spans.find((s) => s.kind === SpanKind.CONSUMER)!;

      // Then
      expect(publish.attributes['messaging.system']).toBe('nats');
      expect(publish.attributes['messaging.operation.name']).toBe('publish');
      expect(publish.attributes['messaging.operation.type']).toBe('send');
      expect(publish.attributes['jetstream.kind']).toBe('event');

      expect(consume.attributes['messaging.system']).toBe('nats');
      expect(consume.attributes['messaging.operation.name']).toBe('process');
      expect(consume.attributes['messaging.operation.type']).toBe('process');
      expect(consume.attributes['messaging.nats.message.delivery_count']).toBe(1);
    });

    it('should set OK span status on successful delivery', async () => {
      // When
      await firstValueFrom(client.emit('orders.created', { orderId: 'order-3' }));
      await waitForCondition(() => controller.received.length === 1, 5_000);
      await provider.forceFlush();

      // Then
      const spans = exporter.getFinishedSpans();

      for (const span of spans) {
        expect(span.status.code).toBe(SpanStatusCode.OK);
      }
    });

    it('should not emit infrastructure spans by default', async () => {
      // When
      await firstValueFrom(client.emit('orders.created', { orderId: 'order-4' }));
      await waitForCondition(() => controller.received.length === 1, 5_000);
      await provider.forceFlush();

      // Then — only the two functional spans, no provisioning/connection/etc.
      const spans = exporter.getFinishedSpans();
      const kinds = new Set(spans.map((s) => s.kind));

      expect(kinds.has(SpanKind.PRODUCER)).toBe(true);
      expect(kinds.has(SpanKind.CONSUMER)).toBe(true);
      // INTERNAL would only be present if infrastructure traces were enabled.
      expect(spans.filter((s: ReadableSpan) => s.kind === SpanKind.INTERNAL)).toHaveLength(0);

      // Belt-and-suspenders: also pin the infrastructure span-name prefixes so
      // a future change that accidentally defaults ConnectionLifecycle /
      // Provisioning / SelfHealing / Migration / Shutdown to ON would fail
      // here instead of going unnoticed.
      const infraPrefixRe =
        /^(jetstream\.(provisioning|migration|self_healing|shutdown)|nats\.connection)/u;

      expect(spans.filter((s: ReadableSpan) => infraPrefixRe.test(s.name))).toHaveLength(0);
    });
  });

  describe('trace kind registration', () => {
    it('should expose JetstreamTrace.Publish and Consume as default-on kinds', () => {
      expect(JetstreamTrace.Publish).toBe('publish');
      expect(JetstreamTrace.Consume).toBe('consume');
    });
  });
});
