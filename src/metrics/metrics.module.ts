import { DynamicModule, Module, Provider } from '@nestjs/common';

import { ConnectionProvider } from '../connection';
import { EventBus } from '../hooks';
import type { JetstreamModuleOptions } from '../interfaces';
import {
  JETSTREAM_CONNECTION,
  JETSTREAM_EVENT_BUS,
  JETSTREAM_OPTIONS,
} from '../jetstream.constants';
import { NameResolver } from '../server/infrastructure/name-resolver';
import { PatternRegistry } from '../server/routing/pattern-registry';
import type { MetricsConfig, MetricsOption } from './metrics.config';
import {
  DEFAULT_METRICS_PREFIX,
  DEFAULT_POLL_INTERVAL_MS,
  JETSTREAM_METRICS_CLIENT,
  JETSTREAM_METRICS_CONFIG,
  JETSTREAM_METRICS_REGISTRY,
} from './metrics.constants';
import { JetstreamMetricsService } from './metrics.service';
import type { LoadedPrometheusClient } from './metrics.types';
import { resolvePrometheusClient } from './prometheus-client';

const userConfig = (option: MetricsOption | undefined): MetricsConfig =>
  option && option !== true ? option : {};

const normalizeMetricsConfig = (
  option: MetricsOption | undefined,
  client: LoadedPrometheusClient,
): MetricsConfig => {
  const user = userConfig(option);

  return {
    register: user.register ?? client.runtime.register,
    prefix: user.prefix ?? DEFAULT_METRICS_PREFIX,
    defaultLabels: user.defaultLabels,
    pollInterval: user.pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
    buckets: user.buckets,
  };
};

/**
 * Internal module wired unconditionally by `JetstreamModule`. Providers gate
 * themselves on `JETSTREAM_OPTIONS.metrics` at resolution time: when metrics
 * are disabled they resolve to `null` and no Prometheus client is loaded, so
 * the peer dependencies stay truly optional.
 */
@Module({})
export class JetstreamMetricsModule {
  public static forFeature(): DynamicModule {
    const clientProvider: Provider = {
      provide: JETSTREAM_METRICS_CLIENT,
      inject: [JETSTREAM_OPTIONS],
      useFactory: async (opts: JetstreamModuleOptions): Promise<LoadedPrometheusClient | null> =>
        opts.metrics ? resolvePrometheusClient(userConfig(opts.metrics).register) : null,
    };

    const configProvider: Provider = {
      provide: JETSTREAM_METRICS_CONFIG,
      inject: [JETSTREAM_OPTIONS, JETSTREAM_METRICS_CLIENT],
      useFactory: (
        opts: JetstreamModuleOptions,
        client: LoadedPrometheusClient | null,
      ): MetricsConfig | null => (client ? normalizeMetricsConfig(opts.metrics, client) : null),
    };

    const registryProvider: Provider = {
      provide: JETSTREAM_METRICS_REGISTRY,
      inject: [JETSTREAM_METRICS_CONFIG],
      useFactory: (cfg: MetricsConfig | null) => cfg?.register ?? null,
    };

    const serviceProvider: Provider = {
      provide: JetstreamMetricsService,
      inject: [
        JETSTREAM_EVENT_BUS,
        JETSTREAM_METRICS_CONFIG,
        JETSTREAM_METRICS_CLIENT,
        JETSTREAM_OPTIONS,
        { token: PatternRegistry, optional: true },
        { token: JETSTREAM_CONNECTION, optional: true },
        { token: NameResolver, optional: true },
      ],
      useFactory: (
        eventBus: EventBus,
        cfg: MetricsConfig | null,
        client: LoadedPrometheusClient | null,
        opts: JetstreamModuleOptions,
        patternRegistry: PatternRegistry | null,
        connection: ConnectionProvider | null,
        names: NameResolver | null,
      ) =>
        new JetstreamMetricsService(
          eventBus,
          cfg,
          client,
          opts,
          patternRegistry,
          connection,
          names,
        ),
    };

    return {
      module: JetstreamMetricsModule,
      providers: [clientProvider, configProvider, registryProvider, serviceProvider],
      exports: [
        JetstreamMetricsService,
        JETSTREAM_METRICS_CONFIG,
        JETSTREAM_METRICS_REGISTRY,
        JETSTREAM_METRICS_CLIENT,
      ],
    };
  }
}
