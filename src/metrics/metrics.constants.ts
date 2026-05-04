import type { ErrorContext, HistogramBuckets } from './metrics.config';

/** DI token for the resolved `MetricsConfig` (with defaults applied). */
export const JETSTREAM_METRICS_CONFIG = Symbol('JETSTREAM_METRICS_CONFIG');

/** DI token for the resolved `prom-client` Registry. */
export const JETSTREAM_METRICS_REGISTRY = Symbol('JETSTREAM_METRICS_REGISTRY');

/** Default metric name prefix. */
export const DEFAULT_METRICS_PREFIX = 'jetstream_';

/** Default polling interval for gauges (ms). */
export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * Default histogram buckets in seconds.
 * Range covers sub-millisecond RPC up to ten-second batch handlers.
 */
export const DEFAULT_HISTOGRAM_BUCKETS: Required<HistogramBuckets> = {
  handlerDuration: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  publishDuration: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  rpcDuration: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
};

/**
 * Mapping of free-form error context strings to bounded {@link ErrorContext} values.
 *
 * Auditors: any new emission site for `TransportEvent.Error` must use a context
 * string that resolves cleanly through {@link mapErrorContext} — extend this
 * map if you introduce a context the mapper does not recognize.
 */
export const ERROR_CONTEXT_PREFIXES: readonly (readonly [string, ErrorContext])[] = [
  ['connection', 'connection'],
  ['codec', 'codec'],
  ['client-rpc', 'publish'],
  ['jetstream-rpc-publish', 'publish'],
  ['publish', 'publish'],
  ['message-provider', 'consume'],
  ['consume', 'consume'],
  ['core-rpc-handler', 'handler'],
  ['rpc-handler', 'handler'],
  ['event-handler', 'handler'],
  ['broadcast-handler', 'handler'],
  ['ordered-handler', 'handler'],
  ['handler', 'handler'],
  ['shutdown', 'shutdown'],
];

/** Sentinel subject label for `jetstream_messages_unhandled_total`. */
export const UNMATCHED_SUBJECT_LABEL = '<unmatched>';
