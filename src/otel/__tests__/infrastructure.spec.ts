import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { faker } from '@faker-js/faker';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { resolveOtelOptions } from '../config';
import {
  beginConnectionLifecycleSpan,
  withMigrationSpan,
  withProvisioningSpan,
  withSelfHealingSpan,
  withShutdownSpan,
} from '../spans/infrastructure';
import { JetstreamTrace } from '../trace-kinds';

const baseCtx = (): {
  serviceName: string;
  endpoint: { host: string; port: number };
} => ({
  serviceName: faker.word.noun(),
  endpoint: { host: faker.internet.ip(), port: 4222 },
});

describe('infrastructure span helpers', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });

  afterEach(() => {
    exporter.reset();
    vi.resetAllMocks();
  });

  describe('toggle gating', () => {
    it('should run op without creating a span when the trace kind is off', async () => {
      // Given — default config has SelfHealing OFF
      const config = resolveOtelOptions();
      const op = vi.fn().mockResolvedValue('result');

      // When
      const result = await withSelfHealingSpan(
        config,
        { ...baseCtx(), consumer: 'c', stream: 's', reason: 'r' },
        op,
      );

      // Then
      expect(result).toBe('result');
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    });

    it('should run op with a span when the trace kind is on', async () => {
      // Given
      const config = resolveOtelOptions({ traces: [JetstreamTrace.Provisioning] });

      // When
      await withProvisioningSpan(
        config,
        { ...baseCtx(), entity: 'consumer', name: 'orders-worker', action: 'create' },
        async () => 'ok',
      );
      await provider.forceFlush();

      // Then
      const spans = exporter.getFinishedSpans();

      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes['jetstream.provisioning.entity']).toBe('consumer');
      expect(spans[0]!.attributes['jetstream.provisioning.action']).toBe('create');
      expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
    });

    it('should mark a span ERROR when the wrapped op throws', async () => {
      // Given
      const config = resolveOtelOptions({ traces: [JetstreamTrace.Migration] });

      // When + Then
      await expect(
        withMigrationSpan(config, { ...baseCtx(), stream: 's1', reason: 'storage' }, async () => {
          throw new Error('migration failed');
        }),
      ).rejects.toThrow('migration failed');
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();

      expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    });
  });

  describe('connection lifecycle handle', () => {
    it('should be a no-op handle when ConnectionLifecycle is off', () => {
      // Given
      const config = resolveOtelOptions();

      // When
      const handle = beginConnectionLifecycleSpan(config, baseCtx());

      // Then — methods exist and do not throw
      expect(() => {
        handle.recordEvent('test');
        handle.finish();
      }).not.toThrow();
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    });

    it('should produce a single INTERNAL span across recordEvent + finish', async () => {
      // Given
      const config = resolveOtelOptions({ traces: [JetstreamTrace.ConnectionLifecycle] });

      // When
      const handle = beginConnectionLifecycleSpan(config, {
        ...baseCtx(),
        server: 'nats.local:4222',
      });

      handle.recordEvent('connection.reconnected');
      handle.finish();
      await provider.forceFlush();

      // Then
      const spans = exporter.getFinishedSpans();

      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe('nats.connection');
      expect(spans[0]!.events.some((e) => e.name === 'connection.reconnected')).toBe(true);
    });
  });

  describe('shutdown helper', () => {
    it('should wrap a shutdown sequence in one INTERNAL span', async () => {
      // Given
      const config = resolveOtelOptions({ traces: [JetstreamTrace.Shutdown] });

      // When
      await withShutdownSpan(config, baseCtx(), async () => undefined);
      await provider.forceFlush();

      // Then
      const spans = exporter.getFinishedSpans();

      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe('jetstream.shutdown');
    });
  });
});
