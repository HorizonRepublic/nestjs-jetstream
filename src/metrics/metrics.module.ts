import { DynamicModule, Module, Provider } from '@nestjs/common';

import { EventBus } from '../hooks';
import type { JetstreamModuleOptions } from '../interfaces';
import { JETSTREAM_EVENT_BUS } from '../jetstream.constants';

import type { MetricsConfig, MetricsOption } from './metrics.config';
import {
  DEFAULT_METRICS_PREFIX,
  DEFAULT_POLL_INTERVAL_MS,
  JETSTREAM_METRICS_CONFIG,
  JETSTREAM_METRICS_PROM_CLIENT,
  JETSTREAM_METRICS_REGISTRY,
} from './metrics.constants';
import type { PromClientRuntime } from './metrics.factory';
import { JetstreamMetricsService } from './metrics.service';

const PROM_CLIENT_INSTALL_MESSAGE =
  'prom-client is required when JetstreamModule.forRoot({ metrics: ... }) is enabled. Install it with: pnpm add prom-client';

/**
 * Dynamically load `prom-client` so the dependency stays optional when the
 * `metrics` option is not set. A clear actionable error is thrown if the peer
 * package is missing at runtime.
 */
const resolvePromClient = async (): Promise<typeof import('prom-client')> => {
  try {
    return await import('prom-client');
  } catch {
    throw new Error(PROM_CLIENT_INSTALL_MESSAGE);
  }
};

/**
 * Normalize the user-provided `metrics` option into a {@link MetricsConfig}
 * with all defaults applied. The registry falls back to `prom-client`'s
 * global `register`, which is also what `@willsoto/nestjs-prometheus`
 * exposes — so default integration works without configuration.
 */
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
 * Internal module activated by `JetstreamModule.forRoot` when metrics are
 * enabled. Provides:
 *
 *  - {@link JetstreamMetricsService} — singleton subscribing to the EventBus.
 *  - {@link JETSTREAM_METRICS_CONFIG} — normalized {@link MetricsConfig}.
 *  - {@link JETSTREAM_METRICS_REGISTRY} — resolved `prom-client` registry.
 *  - {@link JETSTREAM_METRICS_PROM_CLIENT} — dynamically loaded runtime
 *    classes (`Counter`, `Histogram`, `Gauge`) so the factory does not need
 *    a static `import 'prom-client'`.
 *
 * When the `metrics` option is `false`/omitted, `forFeature` returns an empty
 * shell — no providers, no `prom-client` load.
 */
@Module({})
export class JetstreamMetricsModule {
  public static forFeature(options: JetstreamModuleOptions): DynamicModule {
    if (!options.metrics) {
      return { module: JetstreamMetricsModule, providers: [], exports: [] };
    }

    const promClientProvider: Provider = {
      provide: JETSTREAM_METRICS_PROM_CLIENT,
      useFactory: async (): Promise<PromClientRuntime> => {
        const mod = await resolvePromClient();

        /* eslint-disable @typescript-eslint/naming-convention */
        return { Counter: mod.Counter, Histogram: mod.Histogram, Gauge: mod.Gauge };
        /* eslint-enable @typescript-eslint/naming-convention */
      },
    };

    const configProvider: Provider = {
      provide: JETSTREAM_METRICS_CONFIG,
      useFactory: async (): Promise<MetricsConfig> => {
        const mod = await resolvePromClient();

        return normalizeMetricsConfig(options.metrics, mod);
      },
    };

    const registryProvider: Provider = {
      provide: JETSTREAM_METRICS_REGISTRY,
      inject: [JETSTREAM_METRICS_CONFIG],
      useFactory: (cfg: MetricsConfig) => cfg.register,
    };

    const serviceProvider: Provider = {
      provide: JetstreamMetricsService,
      inject: [JETSTREAM_EVENT_BUS, JETSTREAM_METRICS_CONFIG, JETSTREAM_METRICS_PROM_CLIENT],
      useFactory: (eventBus: EventBus, cfg: MetricsConfig, runtime: PromClientRuntime) =>
        new JetstreamMetricsService(eventBus, cfg, runtime),
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
