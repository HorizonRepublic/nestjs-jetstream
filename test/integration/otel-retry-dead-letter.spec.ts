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
} from '@opentelemetry/sdk-trace-base';
import type { NatsConnection } from '@nats-io/transport-node';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { getClientToken } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class FlakyController {
  public attempts = 0;

  @EventPattern('orders.flaky')
  handle(@Payload() _data: unknown): void {
    this.attempts++;
    if (this.attempts < 3) {
      throw new Error(`transient failure attempt ${this.attempts}`);
    }
    // 3rd attempt succeeds
  }
}

@Controller()
class AlwaysFailingController {
  public attempts = 0;
  public deadLetterSeen = false;

  @EventPattern('orders.always-fail')
  handle(@Payload() _data: unknown): void {
    this.attempts++;
    throw new Error(`permanent failure attempt ${this.attempts}`);
  }
}

describe('OTel retry + dead letter integration', () => {
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

  describe('retry chain', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: FlakyController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          events: { consumer: { max_deliver: 5, ack_wait: 2_000_000_000 } },
        },
        [FlakyController],
        [serviceName],
      ));
      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(FlakyController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should produce one CONSUMER span per delivery attempt with incrementing delivery_count', async () => {
      // When
      await firstValueFrom(client.emit('orders.flaky', { id: 'r1' }));
      await waitForCondition(() => controller.attempts >= 3, 15_000);
      await provider.forceFlush();

      // Then
      const consumeSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.kind === SpanKind.CONSUMER)
        .sort(
          (a, b) =>
            (a.attributes['messaging.nats.message.delivery_count'] as number) -
            (b.attributes['messaging.nats.message.delivery_count'] as number),
        );

      expect(consumeSpans.length).toBeGreaterThanOrEqual(3);
      expect(consumeSpans[0]!.attributes['messaging.nats.message.delivery_count']).toBe(1);
      expect(consumeSpans[1]!.attributes['messaging.nats.message.delivery_count']).toBe(2);
      expect(consumeSpans[2]!.attributes['messaging.nats.message.delivery_count']).toBe(3);
    }, 20_000);

    it('should mark failed delivery spans ERROR and the successful one OK', async () => {
      // When
      await firstValueFrom(client.emit('orders.flaky', { id: 'r2' }));
      await waitForCondition(() => controller.attempts >= 3, 15_000);
      await provider.forceFlush();

      // Then
      const consumeSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.kind === SpanKind.CONSUMER)
        .sort(
          (a, b) =>
            (a.attributes['messaging.nats.message.delivery_count'] as number) -
            (b.attributes['messaging.nats.message.delivery_count'] as number),
        );

      const last = consumeSpans[consumeSpans.length - 1]!;

      expect(last.status.code).toBe(SpanStatusCode.OK);
      // The first two attempts threw bare Error → should be ERROR
      expect(consumeSpans[0]!.status.code).toBe(SpanStatusCode.ERROR);
      expect(consumeSpans[1]!.status.code).toBe(SpanStatusCode.ERROR);
    }, 20_000);

    it('should anchor every retry span to the original publish span via traceparent', async () => {
      // When
      await firstValueFrom(client.emit('orders.flaky', { id: 'r3' }));
      await waitForCondition(() => controller.attempts >= 3, 15_000);
      await provider.forceFlush();

      // Then
      const publish = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.PRODUCER)!;
      const consumeSpans = exporter.getFinishedSpans().filter((s) => s.kind === SpanKind.CONSUMER);

      for (const span of consumeSpans) {
        expect(span.spanContext().traceId).toBe(publish.spanContext().traceId);
        expect(span.parentSpanContext?.spanId).toBe(publish.spanContext().spanId);
      }
    }, 20_000);
  });

  describe('dead letter span', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: AlwaysFailingController;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          events: { consumer: { max_deliver: 2, ack_wait: 2_000_000_000 } },
          onDeadLetter: async () => {
            controller.deadLetterSeen = true;
            await Promise.resolve();
          },
        },
        [AlwaysFailingController],
        [serviceName],
      ));
      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(AlwaysFailingController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should produce a dead_letter INTERNAL span as a sibling of the failed Consume spans', async () => {
      // When
      await firstValueFrom(client.emit('orders.always-fail', { id: 'd1' }));
      await waitForCondition(() => controller.deadLetterSeen, 15_000);
      await provider.forceFlush();

      // Then
      const spans = exporter.getFinishedSpans();
      const publish = spans.find((s) => s.kind === SpanKind.PRODUCER)!;
      const deadLetter = spans.find((s) => s.name.startsWith('dead_letter '));

      expect(deadLetter).toBeDefined();
      expect(deadLetter!.kind).toBe(SpanKind.INTERNAL);
      // sibling: shares the publish parent, not a child of any consume span
      expect(deadLetter!.parentSpanContext?.spanId).toBe(publish.spanContext().spanId);
    }, 20_000);
  });
});
