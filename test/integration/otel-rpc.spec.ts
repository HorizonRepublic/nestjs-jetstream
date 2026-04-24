import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, MessagePattern, Payload, RpcException } from '@nestjs/microservices';
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

import { cleanupStreams, createNatsConnection, createTestApp, uniqueServiceName } from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class UsersController {
  @MessagePattern('users.get')
  get(@Payload() data: { readonly id: string }): { readonly id: string; readonly name: string } {
    return { id: data.id, name: 'sample-user' };
  }

  @MessagePattern('users.fail-business')
  failBusiness(): never {
    throw new RpcException({ code: 'NOT_AUTHORIZED', message: 'denied' });
  }

  @MessagePattern('users.fail-infra')
  failInfra(): never {
    throw new Error('database connection lost');
  }
}

@Controller()
class SlowController {
  @MessagePattern('users.slow')
  async slow(): Promise<{ readonly ok: true }> {
    // Never resolves — the RPC router deadline should abort the span.
    await new Promise<void>(() => {});
    return { ok: true };
  }
}

describe('OTel RPC integration', () => {
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

  describe('Core RPC', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      ({ app, module } = await createTestApp(
        { name: serviceName, port, rpc: { mode: 'core' } },
        [UsersController],
        [serviceName],
      ));
      client = module.get<ClientProxy>(getClientToken(serviceName));
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should produce CLIENT + CONSUMER spans linked under one trace', async () => {
      // When
      const reply = await firstValueFrom(client.send('users.get', { id: 'u1' }));

      await provider.forceFlush();

      // Then
      expect(reply).toEqual({ id: 'u1', name: 'sample-user' });

      const spans = exporter.getFinishedSpans();
      const client_ = spans.find((s) => s.kind === SpanKind.CLIENT);
      const consume = spans.find((s) => s.kind === SpanKind.CONSUMER);

      expect(client_).toBeDefined();
      expect(consume).toBeDefined();
      expect(client_!.name).toMatch(/^send /);
      expect(consume!.name).toMatch(/^process /);
      expect(consume!.spanContext().traceId).toBe(client_!.spanContext().traceId);
    });

    it('should mark RpcException-throwing handler with span status OK + has_error attribute', async () => {
      // When
      await expect(firstValueFrom(client.send('users.fail-business', {}))).rejects.toBeDefined();
      await provider.forceFlush();

      // Then
      const spans = exporter.getFinishedSpans();
      const consume = spans.find((s) => s.kind === SpanKind.CONSUMER)!;

      expect(consume.status.code).toBe(SpanStatusCode.OK);
      expect(consume.attributes['jetstream.rpc.reply.has_error']).toBe(true);
      expect(consume.attributes['jetstream.rpc.reply.error.code']).toBe('NOT_AUTHORIZED');
    });

    it('should mark bare-Error-throwing handler with span status ERROR', async () => {
      // When
      await expect(firstValueFrom(client.send('users.fail-infra', {}))).rejects.toBeDefined();
      await provider.forceFlush();

      // Then
      const spans = exporter.getFinishedSpans();
      const consume = spans.find((s) => s.kind === SpanKind.CONSUMER)!;

      expect(consume.status.code).toBe(SpanStatusCode.ERROR);
      expect(consume.events.some((event) => event.name === 'exception')).toBe(true);
    });
  });

  describe('JetStream RPC', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          rpc: { mode: 'jetstream', timeout: 400, concurrency: 1 },
        },
        [SlowController],
        [serviceName],
      ));
      client = module.get<ClientProxy>(getClientToken(serviceName));
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should close the CONSUMER span early when the handler exceeds the RPC deadline', async () => {
      // When — client times out while handler is still pending (never resolves).
      await expect(firstValueFrom(client.send('users.slow', {}))).rejects.toBeDefined();
      // Give the server-side timeout path a tick to fire `abort()` on the signal.
      await new Promise((r) => setTimeout(r, 200));
      await provider.forceFlush();

      // Then — the CONSUMER span was ended by the abort branch with an
      // `rpc.timeout` / `rpc.handler.timeout` event (not left open until
      // the handler eventually resolves).
      const spans = exporter.getFinishedSpans();
      const consume = spans.find((s) => s.kind === SpanKind.CONSUMER);

      expect(consume).toBeDefined();
      expect(consume!.status.code).toBe(SpanStatusCode.ERROR);
      expect(consume!.events.some((e) => e.name === 'rpc.handler.timeout')).toBe(true);
      expect(consume!.endTime).toBeDefined();
    }, 10_000);
  });
});
