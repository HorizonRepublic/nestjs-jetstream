import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';

import type { MetricsConfig } from './metrics.config';
import { DEFAULT_METRICS_PREFIX, DEFAULT_POLL_INTERVAL_MS } from './metrics.constants';
import { createMetrics, type JetstreamMetrics, type PromClientRuntime } from './metrics.factory';

/**
 * Transport events the metrics service consumes. Other events on
 * `TransportEvent` (e.g. shutdown markers) are intentionally not observed.
 */
const OBSERVED_EVENTS = [
  TransportEvent.Connect,
  TransportEvent.Disconnect,
  TransportEvent.Reconnect,
  TransportEvent.Error,
  TransportEvent.RpcTimeout,
  TransportEvent.MessageRouted,
  TransportEvent.DeadLetter,
  TransportEvent.ConsumerRecovered,
  TransportEvent.HandlerCompleted,
] as const satisfies readonly TransportEvent[];

/**
 * Built-in Prometheus metrics service.
 *
 * Activated only when `JetstreamModuleOptions.metrics` is truthy. On
 * `OnApplicationBootstrap` the service instantiates the full metric set on
 * the configured `prom-client` registry, subscribes to relevant
 * {@link TransportEvent}s, and (in a later phase) starts the polling loop
 * for gauges. Critical-path transport code never imports this module —
 * metrics writes happen entirely off the hot path.
 */
@Injectable()
export class JetstreamMetricsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Jetstream:Metrics');

  private metrics: JetstreamMetrics | null = null;

  public constructor(
    private readonly eventBus: EventBus,
    private readonly config: MetricsConfig,
    private readonly promClient: PromClientRuntime,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    if (this.metrics !== null) return;

    if (!this.config.register) {
      throw new Error(
        'JetstreamMetricsService requires a prom-client Registry — none was resolved by JetstreamMetricsModule.',
      );
    }

    this.metrics = createMetrics({
      register: this.config.register,
      promClient: this.promClient,
      prefix: this.config.prefix,
      defaultLabels: this.config.defaultLabels,
      buckets: this.config.buckets,
    });

    this.subscribeToEvents();
    this.logger.log(
      `Metrics enabled (prefix=${this.config.prefix ?? DEFAULT_METRICS_PREFIX}, poll=${this.getEffectivePollInterval()}ms)`,
    );
  }

  public async onModuleDestroy(): Promise<void> {
    // Polling lifecycle wired in Phase E.
  }

  /**
   * Resolved polling interval in milliseconds. `0` means polling is disabled —
   * only event-driven counters/histograms update.
   *
   * @internal Visible for tests.
   */
  public getEffectivePollInterval(): number {
    return this.config.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private subscribeToEvents(): void {
    // Phase C wires concrete handlers per event; until then placeholders keep
    // the subscription topology in place so integration tests can assert that
    // metrics-driven listeners coexist with user hooks without interference.
    const noop = (): void => {
      /* placeholder until Phase C */
    };

    for (const event of OBSERVED_EVENTS) {
      this.eventBus.subscribe(event, noop);
    }
  }
}
