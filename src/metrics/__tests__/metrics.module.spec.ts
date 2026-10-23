import { Global, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { createMock } from '@golevelup/ts-vitest';
import { Registry, register as globalRegister } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { EventBus } from '../../hooks';
import type { JetstreamModuleOptions } from '../../interfaces';
import { JETSTREAM_EVENT_BUS, JETSTREAM_OPTIONS } from '../../jetstream.constants';
import { NameResolver } from '../../server/infrastructure/name-resolver';
import {
  JETSTREAM_METRICS_CLIENT,
  JETSTREAM_METRICS_CONFIG,
  JETSTREAM_METRICS_REGISTRY,
  DEFAULT_METRICS_PREFIX,
  DEFAULT_POLL_INTERVAL_MS,
} from '../metrics.constants';
import { JetstreamMetricsModule } from '../metrics.module';
import { JetstreamMetricsService } from '../metrics.service';
import type { LoadedPrometheusClient } from '../metrics.types';
import { loadPrometheusPackage } from '../prometheus-client';

const baseOptions: JetstreamModuleOptions = {
  name: 'orders',
  servers: ['nats://localhost:4222'],
};

const loadPromClient = async (): Promise<LoadedPrometheusClient> => {
  const runtime = await loadPrometheusPackage('prom-client');

  if (!runtime) throw new Error('prom-client is a dev dependency and must load');

  return { name: 'prom-client', runtime };
};

const compile = async (
  options: JetstreamModuleOptions,
  eventBus: EventBus,
  names?: NameResolver,
  client?: LoadedPrometheusClient,
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

  const builder = Test.createTestingModule({
    imports: [TestRootModule, JetstreamMetricsModule.forFeature()],
  });

  if (client) builder.overrideProvider(JETSTREAM_METRICS_CLIENT).useValue(client);

  return builder.compile();
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
      // Given only prom-client is installed
      const client = await loadPromClient();

      // When
      const moduleRef = await compile(
        { ...baseOptions, metrics: true },
        eventBus,
        undefined,
        client,
      );
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

    it('should load the package the given registry belongs to and expose it via DI', async () => {
      // Given/When
      const moduleRef = await compile(
        { ...baseOptions, metrics: { register: new Registry() } },
        eventBus,
      );
      const client = moduleRef.get<LoadedPrometheusClient>(JETSTREAM_METRICS_CLIENT);

      // Then
      expect(client.name).toBe('prom-client');
      expect(typeof client.runtime.Counter).toBe('function');
      expect(typeof client.runtime.Histogram).toBe('function');
      expect(typeof client.runtime.Gauge).toBe('function');
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
      const moduleRef = await compile(customOptions, eventBus, names, await loadPromClient());

      // When
      const service = moduleRef.get(JetstreamMetricsService);

      // Then: private field 'names' is set via DI
      const injectedNames = Reflect.get(service, 'names') as unknown;

      expect(injectedNames).toBe(names);
    });
  });

  describe('edge cases', () => {
    it('should refuse to guess a registry when both packages are installed', async () => {
      // When / Then
      await expect(compile({ ...baseOptions, metrics: true }, eventBus)).rejects.toThrow(
        /Both @prometheus-io\/client and prom-client are installed/,
      );
    });

    it('should resolve config to null when metrics option is disabled', async () => {
      // Given/When
      const moduleRef = await compile({ ...baseOptions, metrics: false }, eventBus);

      // Then: providers resolve to null, no Prometheus client is loaded, service self-disables
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
