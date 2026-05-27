import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { Global, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createMock } from '@golevelup/ts-vitest';
import { Registry, register as globalRegister } from 'prom-client';

import { EventBus } from '../../hooks';
import type { JetstreamModuleOptions } from '../../interfaces';
import { JETSTREAM_EVENT_BUS, JETSTREAM_OPTIONS } from '../../jetstream.constants';

import {
  JETSTREAM_METRICS_CONFIG,
  JETSTREAM_METRICS_PROM_CLIENT,
  JETSTREAM_METRICS_REGISTRY,
  DEFAULT_METRICS_PREFIX,
  DEFAULT_POLL_INTERVAL_MS,
} from '../metrics.constants';
import { JetstreamMetricsModule } from '../metrics.module';
import type { PromClientRuntime } from '../metrics.factory';
import { JetstreamMetricsService } from '../metrics.service';

const baseOptions: JetstreamModuleOptions = {
  name: 'orders',
  servers: ['nats://localhost:4222'],
};

const compile = async (
  options: JetstreamModuleOptions,
  eventBus: EventBus,
): Promise<import('@nestjs/testing').TestingModule> => {
  @Global()
  @Module({
    providers: [
      { provide: JETSTREAM_EVENT_BUS, useValue: eventBus },
      { provide: JETSTREAM_OPTIONS, useValue: options },
    ],
    exports: [JETSTREAM_EVENT_BUS, JETSTREAM_OPTIONS],
  })
  class TestRootModule {}

  return Test.createTestingModule({
    imports: [TestRootModule, JetstreamMetricsModule.forFeature(options)],
  }).compile();
};

describe(JetstreamMetricsModule, () => {
  let eventBus: Mocked<EventBus>;

  beforeEach(() => {
    eventBus = createMock<EventBus>(new EventBus(createMock<Logger>()));
    globalRegister.clear();
  });

  afterEach(() => {
    vi.resetAllMocks();
    globalRegister.clear();
  });

  describe('happy path', () => {
    it('should provide a resolved MetricsConfig with defaults applied when metrics=true', async () => {
      // Given/When
      const moduleRef = await compile({ ...baseOptions, metrics: true }, eventBus);
      const config = moduleRef.get(JETSTREAM_METRICS_CONFIG);

      // Then
      expect(config.register).toBe(globalRegister);
      expect(config.prefix).toBe(DEFAULT_METRICS_PREFIX);
      expect(config.pollInterval).toBe(DEFAULT_POLL_INTERVAL_MS);
    });

    it('should honor a custom registry and pollInterval from MetricsConfig', async () => {
      // Given
      const customRegister = new Registry();

      // When
      const moduleRef = await compile(
        {
          ...baseOptions,
          metrics: { register: customRegister, pollInterval: 5_000, prefix: 'svc_' },
        },
        eventBus,
      );
      const config = moduleRef.get(JETSTREAM_METRICS_CONFIG);
      const registry = moduleRef.get(JETSTREAM_METRICS_REGISTRY);

      // Then
      expect(config.register).toBe(customRegister);
      expect(config.pollInterval).toBe(5_000);
      expect(config.prefix).toBe('svc_');
      expect(registry).toBe(customRegister);
    });

    it('should resolve prom-client runtime via dynamic import and expose it via DI', async () => {
      // Given/When
      const moduleRef = await compile({ ...baseOptions, metrics: true }, eventBus);
      const promClient = moduleRef.get<PromClientRuntime>(JETSTREAM_METRICS_PROM_CLIENT);

      // Then
      expect(typeof promClient.Counter).toBe('function');
      expect(typeof promClient.Histogram).toBe('function');
      expect(typeof promClient.Gauge).toBe('function');
    });

    it('should instantiate JetstreamMetricsService and register metrics on bootstrap', async () => {
      // Given
      const customRegister = new Registry();
      const moduleRef = await compile(
        { ...baseOptions, metrics: { register: customRegister, pollInterval: 0 } },
        eventBus,
      );

      // When
      await moduleRef.init();

      // Then
      const service = moduleRef.get(JetstreamMetricsService);

      expect(service).toBeInstanceOf(JetstreamMetricsService);
      const text = await customRegister.metrics();

      expect(text).toContain('jetstream_messages_received_total');

      await moduleRef.close();
    });
  });

  describe('edge cases', () => {
    it('should compile as an empty shell when metrics option is disabled', async () => {
      // Given/When
      const moduleRef = await compile({ ...baseOptions, metrics: false }, eventBus);

      // Then: no metrics service or config providers exist
      expect(() => moduleRef.get(JetstreamMetricsService)).toThrow();
      expect(() => moduleRef.get(JETSTREAM_METRICS_CONFIG)).toThrow();
    });

    it('should compile as an empty shell when metrics option is omitted', async () => {
      // Given/When
      const moduleRef = await compile(baseOptions, eventBus);

      // Then
      expect(() => moduleRef.get(JetstreamMetricsService)).toThrow();
    });
  });
});
