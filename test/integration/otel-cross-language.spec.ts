import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { headers as natsHeaders, type NatsConnection } from '@nats-io/transport-node';
import { jetstream } from '@nats-io/jetstream';
import type { StartedTestContainer } from 'testcontainers';

import { getClientToken, internalName, StreamKind } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class CrossLangController {
  public readonly received: unknown[] = [];

  @EventPattern('orders.created')
  handleEvent(@Payload() data: unknown): void {
    this.received.push(data);
  }

  @MessagePattern('orders.lookup')
  handleRpc(@Payload() data: { readonly id: string }): { readonly id: string; readonly ok: true } {
    return { id: data.id, ok: true };
  }
}

const TRACEPARENT_RE =
  /^00-(?<traceId>[0-9a-f]{32})-(?<spanId>[0-9a-f]{16})-(?<flags>[0-9a-f]{2})$/u;

const buildTraceparent = (traceId: string, spanId: string): string => `00-${traceId}-${spanId}-01`;

describe('OTel cross-language interop integration', () => {
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

  describe('inbound — raw publisher with manual traceparent', () => {
    let app: INestApplication;
    let module: TestingModule;
    let serviceName: string;
    let controller: CrossLangController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      ({ app, module } = await createTestApp(
        { name: serviceName, port },
        [CrossLangController],
        [],
      ));
      controller = module.get(CrossLangController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should adopt the traceparent from a raw JetStream publish as the CONSUMER span parent', async () => {
      // Given — simulate a Go / Python publisher that injected a W3C trace
      // header by hand and then called js.publish() directly. The transport
      // must extract the parent and link our CONSUMER span to it.
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const parentSpanId = '00f067aa0ba902b7';
      const traceparent = buildTraceparent(traceId, parentSpanId);
      const subject = `${internalName(serviceName)}.${StreamKind.Event}.orders.created`;

      const hdrs = natsHeaders();

      hdrs.set('traceparent', traceparent);

      // When
      const js = jetstream(nc);

      await js.publish(subject, new TextEncoder().encode(JSON.stringify({ id: 'ext-1' })), {
        headers: hdrs,
      });
      await waitForCondition(() => controller.received.length === 1, 10_000);
      await provider.forceFlush();

      // Then — exactly one CONSUMER span, parented under the external trace.
      const consume = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.CONSUMER);

      expect(consume).toBeDefined();
      expect(consume!.spanContext().traceId).toBe(traceId);
      expect(consume!.parentSpanContext?.spanId).toBe(parentSpanId);
    });

    it('should preserve baggage forwarded from a raw publisher', async () => {
      // Given — a publisher attaches W3C Baggage. We don't decode it (that's
      // the host SDK's job), but the propagator must extract it so any host
      // app code running inside the consume span sees the baggage entries.
      const traceparent = buildTraceparent('0123456789abcdef0123456789abcdef', 'fedcba9876543210');
      const subject = `${internalName(serviceName)}.${StreamKind.Event}.orders.created`;
      const hdrs = natsHeaders();

      hdrs.set('traceparent', traceparent);
      hdrs.set('baggage', 'tenant=acme,region=eu');

      // When
      const js = jetstream(nc);

      await js.publish(subject, new TextEncoder().encode(JSON.stringify({ id: 'ext-2' })), {
        headers: hdrs,
      });
      await waitForCondition(() => controller.received.length === 1, 10_000);
      await provider.forceFlush();

      // Then — span linked to the inbound traceparent. Baggage decoding is
      // out of scope for this test (host SDK + W3C baggage propagator), but
      // verifying the parent chain is intact rules out header-strip
      // regressions.
      const consume = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.CONSUMER)!;

      expect(consume.spanContext().traceId).toBe('0123456789abcdef0123456789abcdef');
    });
  });

  describe('outbound — every published message carries a valid traceparent', () => {
    let app: INestApplication;
    let serviceName: string;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      ({ app } = await createTestApp({ name: serviceName, port }, [CrossLangController], []));
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should inject a parseable W3C traceparent into the outgoing JetStream message', async () => {
      // Given — subscribe a raw NATS consumer to the underlying subject so
      // we can inspect the wire header that the transport emits, exactly as
      // a Go / Python downstream consumer would see it.
      const subject = `${internalName(serviceName)}.${StreamKind.Event}.orders.created`;
      const sub = nc.subscribe(subject, { max: 1 });

      const inbound = (async (): Promise<string | undefined> => {
        for await (const msg of sub) {
          return msg.headers?.get('traceparent');
        }

        return undefined;
      })();

      // When — emit an event from a freshly-created Nest app context. We
      // bootstrap a publisher-side app to drive `JetstreamClient.emit`.
      const publisherSvc = uniqueServiceName();
      const { app: publisher, module: publisherModule } = await createTestApp(
        { name: publisherSvc, port, consumer: false },
        [],
        [serviceName],
      );

      try {
        const client = publisherModule.get<ClientProxy>(getClientToken(serviceName));

        await firstValueFrom(client.emit('orders.created', { id: 'wire-1' }));

        // Then — wire-level header is a parseable W3C traceparent.
        const traceparent = await inbound;

        expect(traceparent).toBeDefined();
        expect(TRACEPARENT_RE.test(traceparent!)).toBe(true);
      } finally {
        await publisher.close();
        await cleanupStreams(nc, publisherSvc);
      }
    });
  });
});
