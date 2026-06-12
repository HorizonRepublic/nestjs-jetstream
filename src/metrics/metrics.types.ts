import type { Counter, Histogram, Gauge, Registry } from 'prom-client';

import type { StreamKind } from '../interfaces';

import type { HistogramBuckets } from './metrics.config';

/**
 * Subset of the `prom-client` runtime surface used by the factory. Injected
 * (rather than statically imported) so nothing here triggers a load until
 * `JetstreamMetricsModule` resolves the peer dependency via dynamic import.
 */
export interface PromClientRuntime {
  /* eslint-disable @typescript-eslint/naming-convention -- mirrors prom-client class names */
  Counter: typeof Counter;
  Histogram: typeof Histogram;
  Gauge: typeof Gauge;
  /* eslint-enable @typescript-eslint/naming-convention */
}

/** Resolved metric handles. Names are stable; emitters use them by property. */
export interface JetstreamMetrics {
  messagesReceivedTotal: Counter<string>;
  messagesProcessedTotal: Counter<string>;
  messagesUnhandledTotal: Counter<string>;
  messagesDeadLetterTotal: Counter<string>;
  publishTotal: Counter<string>;
  rpcTimeoutTotal: Counter<string>;
  consumerRecoveredTotal: Counter<string>;
  errorsTotal: Counter<string>;
  handlerDurationSeconds: Histogram<string>;
  publishDurationSeconds: Histogram<string>;
  rpcDurationSeconds: Histogram<string>;
  consumerNumPending: Gauge<string>;
  consumerNumAckPending: Gauge<string>;
  consumerNumRedelivered: Gauge<string>;
  consumerNumWaiting: Gauge<string>;
  streamMessages: Gauge<string>;
  streamBytes: Gauge<string>;
  connectionUp: Gauge<string>;
  metricsPollErrorsTotal: Counter<string>;
}

export interface CreateMetricsOptions {
  register: Registry;
  promClient: PromClientRuntime;
  prefix?: string;
  defaultLabels?: Record<string, string>;
  buckets?: HistogramBuckets;
}

/** A consumer this service owns: stream + durable + StreamKind for labelling. */
export interface ConsumerPollTarget {
  kind: StreamKind;
  stream: string;
  consumer: string;
}

/**
 * Inputs for the polling loop. `targets` lists every consumer this service
 * owns; stream gauges are derived from `targets[].stream`, deduplicated.
 */
export interface PollRunnerOptions {
  intervalMs: number;
  jsmFactory(): Promise<import('@nats-io/jetstream').JetStreamManager>;
  metrics: JetstreamMetrics;
  targets: ConsumerPollTarget[];
}

/** Bounded label values for `metrics_poll_errors_total{target}`. */
export type PollErrorTarget = 'consumer.info' | 'stream.info' | 'jsm.connect';

/** Subject-resolution result used internally by the metrics service. */
export interface ResolvedSubjectLabels {
  pattern: string;
  kind: StreamKind;
}

/** Label accepted by ConsumerRecovered: typically StreamKind, may be any string. */
export type RecoveredKindLabel = StreamKind | string;
