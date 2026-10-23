/**
 * The part of a Prometheus registry the transport relies on. Both
 * `prom-client` and `@prometheus-io/client` registries satisfy it, so neither
 * package has to be installed for these types to resolve.
 */
export interface MetricsRegistry {
  /** Labels merged into every metric of the registry. */
  setDefaultLabels(labels: Record<string, string>): void;

  /** Called by each metric constructor that lists this registry. */
  registerMetric(metric: unknown): void;
}

/**
 * Labels (in seconds) for histogram bucket configuration.
 * Override defaults via `JetstreamModuleOptions.metrics.buckets`.
 */
export interface HistogramBuckets {
  /** Buckets for `jetstream_handler_duration_seconds`. */
  handlerDuration?: number[];
  /** Buckets for `jetstream_publish_duration_seconds`. */
  publishDuration?: number[];
  /** Buckets for `jetstream_rpc_duration_seconds`. */
  rpcDuration?: number[];
}

/**
 * Configuration for built-in Prometheus metrics. All fields are optional;
 * sensible production defaults are applied when missing.
 */
export interface MetricsConfig {
  /**
   * Registry to write metrics into, from `@prometheus-io/client` or
   * `prom-client`. The metrics are built with classes from the same package.
   *
   * Defaults to the global `register` of whichever of the two is installed,
   * which is also what `@willsoto/nestjs-prometheus` exposes via `/metrics`.
   * Required when both are installed, because the two global registries are
   * different objects and only one of them is scraped.
   */
  register?: MetricsRegistry;

  /** Metric name prefix. Defaults to `'jetstream_'`. */
  prefix?: string;

  /** Labels merged into every metric. Useful for service/env tagging. */
  defaultLabels?: Record<string, string>;

  /**
   * Polling interval (ms) for gauge metrics that query `JetStreamManager`
   * (consumer pending, stream messages, etc.). Default `15_000`.
   * Set to `0` to disable polling; counter/histogram metrics still update
   * via the event bus.
   */
  pollInterval?: number;

  /** Override default histogram buckets. */
  buckets?: HistogramBuckets;
}

/**
 * Shorthand for `MetricsConfig`. Pass `true` to enable with all defaults,
 * `false` (or omit) to disable entirely.
 */
export type MetricsOption = boolean | MetricsConfig;

/**
 * Bounded enum used to label `jetstream_errors_total{context}`. Free-form
 * context strings emitted by transport are mapped to one of these values
 * by the metrics service (unknown -> `other`).
 */
export type ErrorContext =
  | 'connection'
  | 'codec'
  | 'publish'
  | 'consume'
  | 'handler'
  | 'shutdown'
  | 'other';
