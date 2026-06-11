import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { Global, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createMock } from '@golevelup/ts-vitest';
import { Registry, register as globalRegister } from 'prom-client';

import { EventBus } from '../../hooks';
import type { JetstreamModuleOptions } from '../../interfaces';
import { JETSTREAM_EVENT_BUS, JETSTREAM_OPTIONS } from '../../jetstream.constants';
import { NameResolver } from '../../server/infrastructure/name-resolver';

import {
  JETSTREAM_METRICS_CONFIG,
  JETSTREAM_METRICS_PROM_CLIENT,
  JETSTREAM_METRICS_REGISTRY,
  DEFAULT_METRICS_PREFIX,
  DEFAULT_POLL_INTERVAL_MS,
} from '../metrics.constants';
import { JetstreamMetricsModule } from '../metrics.module';
import { JetstreamMetricsService } from '../metrics.service';
import type { PromClientRuntime } from '../metrics.types';

const baseOptions: JetstreamModuleOptions = {
  name: 'orders',
  servers: ['nats://localhost:4222'],
};

const compile = async (
  options: JetstreamModuleOptions,
  eventBus: EventBus,
  names?: NameResolver,
): Promise<import('@nestjs/testing').TestingModule> => {
  const extraProviders = names ? [{ provide: NameResolver, useValue: names }] : [];
  const extraExports = names ? [NameResolver] : [];

  @Global()
  @Module({
    providers: [
      { provide: JETSTREAM_EVENT_BUS, useValue: eventBus },
      { provide: JETSTREAM_OPTIONS, useValue: options },
      ...extraProviders,
    ],
    exports: [JETSTREAM_EVENT_BUS, JETSTREAM_OPTIONS, ...extraExports],
  })
  class TestRootModule {}

  return Test.createTestingModule({
    imports: [TestRootModule, JetstreamMetricsModule.forFeature()],
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

  describe('NameResolver forwarding', () => {
    it('should inject NameResolver into JetstreamMetricsService when available in DI', async () => {
      // Given: NameResolver is provided (as JetstreamModule does via exports)
      const customOptions: JetstreamModuleOptions = {
        ...baseOptions,
        metrics: true,
        events: { stream: { name: 'custom-ev-stream' } },
      };
      const names = new NameResolver(customOptions);
      const moduleRef = await compile(customOptions, eventBus, names);

      // When
      const service = moduleRef.get(JetstreamMetricsService);

      // Then: private field 'names' is set (not null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((service as any).names).toBe(names);
    });
  });

  describe('edge cases', () => {
    it('should resolve config to null when metrics option is disabled', async () => {
      // Given/When
      const moduleRef = await compile({ ...baseOptions, metrics: false }, eventBus);

      // Then: providers exist (module is always imported) but resolve to null,
      // so prom-client is never loaded and the service self-disables on bootstrap.
      expect(moduleRef.get(JETSTREAM_METRICS_CONFIG)).toBeNull();
      expect(moduleRef.get(JetstreamMetricsService)).toBeInstanceOf(JetstreamMetricsService);
    });

    it('should resolve config to null when metrics option is omitted', async () => {
      // Given/When
      const moduleRef = await compile(baseOptions, eventBus);

      // Then
      expect(moduleRef.get(JETSTREAM_METRICS_CONFIG)).toBeNull();
      expect(moduleRef.get(JetstreamMetricsService)).toBeInstanceOf(JetstreamMetricsService);
    });
  });
});
