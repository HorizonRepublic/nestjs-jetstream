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
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { getClientToken, JetstreamRecordBuilder, toNanos } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class KindsController {
  public readonly events: unknown[] = [];
  public readonly broadcasts: unknown[] = [];
  public readonly ordered: unknown[] = [];
  public readonly scheduled: unknown[] = [];

  @EventPattern('orders.created')
  handleEvent(@Payload() data: unknown): void {
    this.events.push(data);
  }

  @EventPattern('config.updated', { broadcast: true })
  handleBroadcast(@Payload() data: unknown): void {
    this.broadcasts.push(data);
  }

  @EventPattern('orders.status', { ordered: true })
  handleOrdered(@Payload() data: unknown): void {
    this.ordered.push(data);
  }

  @EventPattern('orders.scheduled')
  handleScheduled(@Payload() data: unknown): void {
    this.scheduled.push(data);
  }
}

describe('OTel message-kind attributes integration — broadcast, ordered, scheduled', () => {
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

  let app: INestApplication;
  let module: TestingModule;
  let client: ClientProxy;
  let controller: KindsController;
  let serviceName: string;

  beforeEach(async () => {
    serviceName = uniqueServiceName();
    ({ app, module } = await createTestApp(
      {
        name: serviceName,
        port,
        events: { stream: { allow_msg_schedules: true } },
      },
      [KindsController],
      [serviceName],
    ));
    client = module.get<ClientProxy>(getClientToken(serviceName));
    controller = module.get(KindsController);
  });

  afterEach(async () => {
    await app.close();
    await cleanupStreams(nc, serviceName);
  });

  describe('broadcast event', () => {
    it('should tag both producer and consumer spans with jetstream.kind=broadcast', async () => {
      // When
      await firstValueFrom(client.emit('broadcast:config.updated', { key: 'feature.x' }));
      await waitForCondition(() => controller.broadcasts.length === 1, 5_000);
      await provider.forceFlush();

      // Then
      const spans = exporter.getFinishedSpans();
      const publish = spans.find((s) => s.kind === SpanKind.PRODUCER)!;
      const consume = spans.find((s) => s.kind === SpanKind.CONSUMER)!;

      expect(publish.attributes['jetstream.kind']).toBe('broadcast');
      expect(consume.attributes['jetstream.kind']).toBe('broadcast');

      // Span name uses the actual subject (`broadcast.config.updated`), not
      // the user pattern (`broadcast:config.updated`).
      expect(publish.name).toBe('publish broadcast.config.updated');
      expect(consume.name).toBe('process broadcast.config.updated');
    });
  });

  describe('ordered event', () => {
    it('should tag both producer and consumer spans with jetstream.kind=ordered', async () => {
      // When
      await firstValueFrom(client.emit('ordered:orders.status', { status: 'queued' }));
      await waitForCondition(() => controller.ordered.length === 1, 5_000);
      await provider.forceFlush();

      // Then
      const spans = exporter.getFinishedSpans();
      const publish = spans.find((s) => s.kind === SpanKind.PRODUCER)!;
      const consume = spans.find((s) => s.kind === SpanKind.CONSUMER)!;

      expect(publish.attributes['jetstream.kind']).toBe('ordered');
      expect(consume.attributes['jetstream.kind']).toBe('ordered');
    });
  });

  describe('scheduled event', () => {
    it('should set jetstream.schedule.target to the consumer subject on the publish span', async () => {
      // Given — schedule a delivery 1s out so the test runs reasonably fast.
      const payload = { orderId: 'sch-1' };
      const record = new JetstreamRecordBuilder(payload)
        .scheduleAt(new Date(Date.now() + 1_000))
        .build();

      // When
      await firstValueFrom(client.emit('orders.scheduled', record));
      await waitForCondition(() => controller.scheduled.length === 1, 10_000);
      await provider.forceFlush();

      // Then — the publish span captures the scheduled subject as its
      // `jetstream.schedule.target`, while `messaging.destination.name`
      // points at the physical `_sch.*` subject that NATS stores.
      const spans = exporter.getFinishedSpans();
      const publish = spans
        .filter((s) => s.kind === SpanKind.PRODUCER)
        .find(
          (s) =>
            (s.attributes['jetstream.schedule.target'] as string | undefined)?.endsWith(
              'orders.scheduled',
            ) ?? false,
        );

      expect(publish).toBeDefined();
      expect(publish!.attributes['jetstream.schedule.target']).toMatch(/orders\.scheduled$/u);
      expect(publish!.attributes['messaging.destination.name']).toMatch(
        /_sch\..*orders\.scheduled$/u,
      );

      // Consumer span sees the original subject after the broker redelivers
      // (no `_sch.` prefix).
      const consume = spans.find(
        (s) =>
          s.kind === SpanKind.CONSUMER &&
          (s.attributes['messaging.destination.name'] as string | undefined)?.endsWith(
            'orders.scheduled',
          ),
      );

      expect(consume).toBeDefined();
      expect(consume!.attributes['messaging.destination.name']).not.toMatch(/_sch\./u);
    }, 15_000);
  });

  describe('per-message TTL header', () => {
    it('should never expose the Nats-TTL header as messaging.header.* even with captureHeaders=true', async () => {
      // Given — re-bootstrap with TTL allowed on the stream and full
      // capture so we can prove the denylist still wins.
      await app.close();
      await cleanupStreams(nc, serviceName);

      serviceName = uniqueServiceName();
      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          events: { stream: { allow_msg_ttl: true } },
          otel: { captureHeaders: true },
        },
        [KindsController],
        [serviceName],
      ));
      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(KindsController);

      const record = new JetstreamRecordBuilder({ id: 'ttl-1' })
        .ttl(toNanos(60, 'seconds'))
        .build();

      // When
      await firstValueFrom(client.emit('orders.created', record));
      await waitForCondition(() => controller.events.length === 1, 5_000);
      await provider.forceFlush();

      // Then — `Nats-TTL` is server-managed, never useful as a span attr.
      // It is in our HEADER_DENYLIST so it must not appear under any
      // casing on either span.
      const spans = exporter.getFinishedSpans();

      for (const span of spans) {
        for (const key of Object.keys(span.attributes)) {
          expect(key.toLowerCase().includes('nats-ttl')).toBe(false);
        }
      }
    });
  });
});
