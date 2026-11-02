import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

import { type NatsConnection } from '@nats-io/transport-node';

import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  type ReadableSpan,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getClientToken } from '../../src';
import type { JetstreamModuleOptions } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

type RpcMode = 'core' | 'jetstream';

@Controller()
class WildcardController {
  public readonly handled: string[] = [];

  @EventPattern('orders.*')
  order(@Payload() _data: unknown): void {
    this.handled.push('orders.*');
  }

  @EventPattern('orders.special')
  special(@Payload() _data: unknown): void {
    this.handled.push('orders.special');
  }

  @EventPattern('ledger.>', { ordered: true })
  ledger(@Payload() _data: unknown): void {
    this.handled.push('ledger.>');
  }

  @MessagePattern('reports.*')
  report(@Payload() _data: unknown): string {
    return 'ok';
  }
}

describe('OTel consume spans for wildcard handlers', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;
  let exporter: InMemorySpanExporter;
  let provider: TracerProvider;
  let app: INestApplication | undefined;
  let serviceName: string;
  let hookPatterns: string[];

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);

    exporter = new InMemorySpanExporter();
    provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
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

  afterEach(async () => {
    exporter.reset();
    await app?.close();
    app = undefined;
    await cleanupStreams(nc, serviceName);
  });

  const start = async (
    mode: RpcMode,
  ): Promise<{ client: ClientProxy; controller: WildcardController }> => {
    serviceName = uniqueServiceName();
    hookPatterns = [];

    const rpc: JetstreamModuleOptions['rpc'] =
      mode === 'jetstream' ? { mode: 'jetstream' } : undefined;
    const started = await createTestApp(
      {
        name: serviceName,
        port,
        rpc,
        otel: {
          consumeHook: (_span, ctx) => {
            hookPatterns.push(ctx.handlerMetadata.pattern);
          },
        },
      },
      [WildcardController],
      [serviceName],
    );

    app = started.app;

    return {
      client: started.module.get<ClientProxy>(getClientToken(serviceName)),
      controller: started.module.get(WildcardController),
    };
  };

  const consumeSpanFor = (subjectSuffix: string): ReadableSpan | undefined =>
    exporter
      .getFinishedSpans()
      .find((s) => s.kind === SpanKind.CONSUMER && s.name.endsWith(subjectSuffix));

  it('labels event and ordered spans with the declared pattern', async () => {
    // Given
    const { client, controller } = await start('core');

    // When
    await firstValueFrom(client.emit('orders.created', {}));
    await firstValueFrom(client.emit('orders.special', {}));
    await firstValueFrom(client.emit('ordered:ledger.eu.1', {}));
    await waitForCondition(() => controller.handled.length === 3, 10_000);
    await provider.forceFlush();

    // Then
    expect(consumeSpanFor('.ev.orders.created')?.attributes['messaging.destination.template']).toBe(
      'orders.*',
    );
    expect(consumeSpanFor('.ev.orders.special')?.attributes['messaging.destination.template']).toBe(
      'orders.special',
    );
    expect(
      consumeSpanFor('.ordered.ledger.eu.1')?.attributes['messaging.destination.template'],
    ).toBe('ledger.>');
    expect(hookPatterns).toEqual(
      expect.arrayContaining(['orders.*', 'orders.special', 'ledger.>']),
    );
  }, 30_000);

  it.each<RpcMode>(['core', 'jetstream'])(
    'labels %s RPC spans with the declared pattern',
    async (mode) => {
      // Given
      const { client } = await start(mode);

      // When
      await expect(firstValueFrom(client.send('reports.daily', {}))).resolves.toBe('ok');
      await provider.forceFlush();

      // Then
      expect(
        consumeSpanFor('.cmd.reports.daily')?.attributes['messaging.destination.template'],
      ).toBe('reports.*');
      expect(hookPatterns).toEqual(['reports.*']);
    },
    30_000,
  );
});
