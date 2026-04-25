import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { type NatsConnection } from '@nats-io/transport-node';
import { jetstreamManager, type JetStreamManager } from '@nats-io/jetstream';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { consumerName, getClientToken, JetstreamTrace, StreamKind, streamName } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class InfraController {
  public readonly received: unknown[] = [];

  @EventPattern('orders.created')
  handle(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

describe('OTel infrastructure spans integration — provisioning, shutdown, self-healing', () => {
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  let container: StartedTestContainer;
  let port: number;
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);
    jsm = await jetstreamManager(nc);

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

  describe('provisioning spans', () => {
    let app: INestApplication;
    let serviceName: string;

    afterEach(async () => {
      await app.close().catch(() => undefined);
      await cleanupStreams(nc, serviceName).catch(() => undefined);
    });

    it('should emit jetstream.provisioning.stream + jetstream.provisioning.consumer spans on app startup', async () => {
      // Given — Provisioning is OFF by default; we have to opt in alongside
      // the default messaging traces so the app still produces normal spans.
      serviceName = uniqueServiceName();
      ({ app } = await createTestApp(
        {
          name: serviceName,
          port,
          otel: {
            traces: [
              JetstreamTrace.Publish,
              JetstreamTrace.Consume,
              JetstreamTrace.RpcClientSend,
              JetstreamTrace.DeadLetter,
              JetstreamTrace.Provisioning,
            ],
          },
        },
        [InfraController],
        [],
      ));

      await provider.forceFlush();

      // Then — at least one stream-provisioning span and one
      // consumer-provisioning span have closed by now.
      const spans = exporter.getFinishedSpans();
      const streamSpan = spans.find(
        (s) =>
          s.name === 'jetstream.provisioning.stream' &&
          s.attributes['jetstream.provisioning.entity'] === 'stream',
      );
      const consumerSpan = spans.find(
        (s) =>
          s.name === 'jetstream.provisioning.consumer' &&
          s.attributes['jetstream.provisioning.entity'] === 'consumer',
      );

      expect(streamSpan).toBeDefined();
      expect(consumerSpan).toBeDefined();
      expect(streamSpan!.attributes['jetstream.provisioning.action']).toBe('ensure');
      expect(consumerSpan!.attributes['jetstream.provisioning.action']).toBe('ensure');
      expect(streamSpan!.attributes['jetstream.provisioning.name']).toBe(
        streamName(serviceName, StreamKind.Event),
      );
      expect(consumerSpan!.attributes['jetstream.provisioning.name']).toBe(
        consumerName(serviceName, StreamKind.Event),
      );
    });

    it('should not emit provisioning spans by default (opt-in trace kind)', async () => {
      // Given — default trace set excludes Provisioning.
      serviceName = uniqueServiceName();
      ({ app } = await createTestApp({ name: serviceName, port }, [InfraController], []));

      await provider.forceFlush();

      // Then
      const spans = exporter.getFinishedSpans();

      expect(spans.filter((s) => s.name.startsWith('jetstream.provisioning.'))).toHaveLength(0);
    });
  });

  describe('shutdown span', () => {
    it('should emit jetstream.shutdown when Shutdown trace is enabled and app.close() is called', async () => {
      // Given
      const serviceName = uniqueServiceName();
      const { app } = await createTestApp(
        {
          name: serviceName,
          port,
          otel: {
            traces: [JetstreamTrace.Publish, JetstreamTrace.Consume, JetstreamTrace.Shutdown],
          },
        },
        [InfraController],
        [],
      );

      try {
        // When
        await app.close();
        await provider.forceFlush();

        // Then
        const span = exporter.getFinishedSpans().find((s) => s.name === 'jetstream.shutdown');

        expect(span).toBeDefined();
        expect(span!.kind).toBe(SpanKind.INTERNAL);
        expect(span!.attributes['jetstream.service.name']).toBeDefined();
      } finally {
        await cleanupStreams(nc, serviceName);
      }
    });
  });

  describe('connection lifecycle span', () => {
    it('should emit a single nats.connection span covering the connection session', async () => {
      // Given
      const serviceName = uniqueServiceName();
      const { app } = await createTestApp(
        {
          name: serviceName,
          port,
          otel: {
            traces: [
              JetstreamTrace.Publish,
              JetstreamTrace.Consume,
              JetstreamTrace.ConnectionLifecycle,
              JetstreamTrace.Shutdown,
            ],
          },
        },
        [InfraController],
        [],
      );

      try {
        // The connection span finalizes when shutdown closes the connection.
        await app.close();
        await provider.forceFlush();

        // Then
        const lifecycle = exporter.getFinishedSpans().filter((s) => s.name === 'nats.connection');

        expect(lifecycle).toHaveLength(1);
        expect(lifecycle[0]!.kind).toBe(SpanKind.INTERNAL);
        expect(lifecycle[0]!.attributes['nats.connection.server']).toBeDefined();
      } finally {
        await cleanupStreams(nc, serviceName);
      }
    });
  });

  describe('self-healing span', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: InfraController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          otel: {
            traces: [JetstreamTrace.Publish, JetstreamTrace.Consume, JetstreamTrace.SelfHealing],
          },
        },
        [InfraController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(InfraController);
    });

    afterEach(async () => {
      await app.close().catch(() => undefined);
      await cleanupStreams(nc, serviceName).catch(() => undefined);
    });

    it('should emit jetstream.self_healing when an externally-deleted consumer is recovered', async () => {
      // Given — first message gets consumed normally, proving the consumer is up.
      await firstValueFrom(client.emit('orders.created', { phase: 'baseline' }));
      await waitForCondition(() => controller.received.length >= 1, 10_000);

      // When — delete the consumer out from under the running app, then
      // publish another message. Self-healing detects the missing consumer
      // and recreates it; the span helper wraps that recovery operation.
      const evStream = streamName(serviceName, StreamKind.Event);
      const evConsumer = consumerName(serviceName, StreamKind.Event);

      await jsm.consumers.delete(evStream, evConsumer);

      await firstValueFrom(client.emit('orders.created', { phase: 'after-delete' }));
      await waitForCondition(() => controller.received.length >= 2, 30_000);
      await provider.forceFlush();

      // Then
      const span = exporter.getFinishedSpans().find((s) => s.name === 'jetstream.self_healing');

      expect(span).toBeDefined();
      expect(span!.kind).toBe(SpanKind.INTERNAL);
      expect(span!.attributes['jetstream.self_healing.reason']).toBeDefined();
      expect(span!.attributes['messaging.consumer.group.name']).toBe(evConsumer);
      expect(span!.attributes['messaging.nats.stream.name']).toBe(evStream);
    }, 60_000);
  });
});
