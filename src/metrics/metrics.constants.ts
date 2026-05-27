import { StreamKind } from '../interfaces';

import type { ErrorContext, HistogramBuckets } from './metrics.config';

/** DI token for the resolved {@link MetricsConfig} (defaults applied). */
export const JETSTREAM_METRICS_CONFIG = Symbol('JETSTREAM_METRICS_CONFIG');

/** DI token for the resolved `prom-client` Registry. */
export const JETSTREAM_METRICS_REGISTRY = Symbol('JETSTREAM_METRICS_REGISTRY');

/** DI token for the dynamically loaded `prom-client` runtime classes. */
export const JETSTREAM_METRICS_PROM_CLIENT = Symbol('JETSTREAM_METRICS_PROM_CLIENT');

export const DEFAULT_METRICS_PREFIX = 'jetstream_';

export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Buckets in seconds, covering sub-millisecond RPC up to ten-second batch handlers. */
export const DEFAULT_HISTOGRAM_BUCKETS: Required<HistogramBuckets> = {
  handlerDuration: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  publishDuration: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  rpcDuration: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
};

/**
 * Maps free-form `TransportEvent.Error` context strings to bounded
 * {@link ErrorContext} values via prefix match (unknown → `other`). Extend
 * this list whenever a new emission site introduces an unfamiliar context.
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
  // EventRouter formats contexts as `${StreamKind.*}-handler:...` — the enum
  // uses short forms (`ev`, `ordered`, `broadcast`) so both surface in the wild.
  ['ev-handler', 'handler'],
  ['event-handler', 'handler'],
  ['broadcast-handler', 'handler'],
  ['ordered-handler', 'handler'],
  ['handler', 'handler'],
  ['shutdown', 'shutdown'],
];

/** Sentinel for `jetstream_messages_unhandled_total{subject}`. */
export const UNMATCHED_SUBJECT_LABEL = '<unmatched>';

/**
 * Expands the short-form {@link StreamKind} enum values (`ev`, `cmd`) into
 * full words for Prometheus labels. Cardinality stays fixed at four.
 */
export const STREAM_KIND_LABEL: Record<StreamKind, string> = {
  [StreamKind.Event]: 'event',
  [StreamKind.Command]: 'command',
  [StreamKind.Broadcast]: 'broadcast',
  [StreamKind.Ordered]: 'ordered',
};
