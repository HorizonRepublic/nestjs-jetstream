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
  JETSTREAM_METRICS_CONFIG,
  JETSTREAM_METRICS_PROM_CLIENT,
  JETSTREAM_METRICS_REGISTRY,
} from './metrics.constants';
import type { PromClientRuntime } from './metrics.types';
import { JetstreamMetricsService } from './metrics.service';

const PROM_CLIENT_INSTALL_MESSAGE =
  'prom-client is required when JetstreamModule.forRoot({ metrics: ... }) is enabled. Install it with: pnpm add prom-client';

/** Dynamic import so `prom-client` stays a truly optional peer dependency. */
const resolvePromClient = async (): Promise<typeof import('prom-client')> => {
  try {
    return await import('prom-client');
  } catch {
    throw new Error(PROM_CLIENT_INSTALL_MESSAGE);
  }
};

const normalizeMetricsConfig = (
  option: MetricsOption | undefined,
  promClient: typeof import('prom-client'),
): MetricsConfig => {
  const user: MetricsConfig = option && option !== true ? option : {};

  return {
    register: user.register ?? promClient.register,
    prefix: user.prefix ?? DEFAULT_METRICS_PREFIX,
    defaultLabels: user.defaultLabels,
    pollInterval: user.pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
    buckets: user.buckets,
  };
};

/**
 * Internal module wired unconditionally by `JetstreamModule`. Providers gate
 * themselves on `JETSTREAM_OPTIONS.metrics` at resolution time — when metrics
 * are disabled they resolve to `null` and `prom-client` is never loaded, so
 * the peer dependency stays truly optional.
 */
@Module({})
export class JetstreamMetricsModule {
  public static forFeature(): DynamicModule {
    const promClientProvider: Provider = {
      provide: JETSTREAM_METRICS_PROM_CLIENT,
      inject: [JETSTREAM_OPTIONS],
      useFactory: async (opts: JetstreamModuleOptions): Promise<PromClientRuntime | null> => {
        if (!opts.metrics) return null;
        const mod = await resolvePromClient();

        /* eslint-disable @typescript-eslint/naming-convention */
        return { Counter: mod.Counter, Histogram: mod.Histogram, Gauge: mod.Gauge };
        /* eslint-enable @typescript-eslint/naming-convention */
      },
    };

    const configProvider: Provider = {
      provide: JETSTREAM_METRICS_CONFIG,
      inject: [JETSTREAM_OPTIONS],
      useFactory: async (opts: JetstreamModuleOptions): Promise<MetricsConfig | null> => {
        if (!opts.metrics) return null;
        const mod = await resolvePromClient();

        return normalizeMetricsConfig(opts.metrics, mod);
      },
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
        JETSTREAM_METRICS_PROM_CLIENT,
        JETSTREAM_OPTIONS,
        { token: PatternRegistry, optional: true },
        { token: JETSTREAM_CONNECTION, optional: true },
        { token: NameResolver, optional: true },
      ],
      useFactory: (
        eventBus: EventBus,
        cfg: MetricsConfig | null,
        runtime: PromClientRuntime | null,
        opts: JetstreamModuleOptions,
        patternRegistry: PatternRegistry | null,
        connection: ConnectionProvider | null,
        names: NameResolver | null,
      ) =>
        new JetstreamMetricsService(
          eventBus,
          cfg,
          runtime,
          opts,
          patternRegistry,
          connection,
          names,
        ),
    };

    return {
      module: JetstreamMetricsModule,
      providers: [promClientProvider, configProvider, registryProvider, serviceProvider],
      exports: [
        JetstreamMetricsService,
        JETSTREAM_METRICS_CONFIG,
        JETSTREAM_METRICS_REGISTRY,
        JETSTREAM_METRICS_PROM_CLIENT,
      ],
    };
  }
}
