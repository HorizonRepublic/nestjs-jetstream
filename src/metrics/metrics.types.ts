import type { StreamKind } from '../interfaces';
import type { HistogramBuckets, MetricsRegistry } from './metrics.config';

/** Label values keyed by label name. */
export type MetricLabels = Record<string, string | number>;

/** A counter bound to one label combination. */
export interface CounterSeries {
  inc(value?: number): void;
}

/** A gauge bound to one label combination. */
export interface GaugeSeries {
  set(value: number): void;
}

/** A histogram bound to one label combination. */
export interface HistogramSeries {
  observe(value: number): void;
}

export interface MetricCounter {
  labels(labels: MetricLabels): CounterSeries;
}

export interface MetricGauge {
  labels(labels: MetricLabels): GaugeSeries;
}

export interface MetricHistogram {
  labels(labels: MetricLabels): HistogramSeries;
}

/** Constructor options shared by every metric type. */
export interface MetricDefinition<R extends MetricsRegistry = MetricsRegistry> {
  name: string;
  help: string;
  labelNames: string[];
  registers: R[];
}

export interface HistogramDefinition<
  R extends MetricsRegistry = MetricsRegistry,
> extends MetricDefinition<R> {
  buckets: number[];
}

/**
 * The metric classes of one Prometheus client package, `@prometheus-io/client`
 * or `prom-client`, plus that package's global registry. Loaded through
 * `import()` only when metrics are enabled.
 *
 * `R` is the package's own Registry class, which its metric constructors
 * insist on. Past the loader it is erased to {@link MetricsRegistry}.
 */
export interface PrometheusRuntime<R extends MetricsRegistry = MetricsRegistry> {
  Counter: new (definition: MetricDefinition<R>) => MetricCounter;
  Gauge: new (definition: MetricDefinition<R>) => MetricGauge;
  Histogram: new (definition: HistogramDefinition<R>) => MetricHistogram;
  Registry: abstract new () => R;
  register: R;
}

/** A Prometheus client package the transport can load. */
export type PrometheusPackage = '@prometheus-io/client' | 'prom-client';

/** Imports one Prometheus client package; rejects when it cannot be loaded. */
export type PrometheusImporter = (name: PrometheusPackage) => Promise<PrometheusRuntime>;

/** Loads one Prometheus client package, or returns `null` when it is not installed. */
export type PrometheusLoader = (name: PrometheusPackage) => Promise<PrometheusRuntime | null>;

/** An installed Prometheus client package and its runtime. */
export interface LoadedPrometheusClient {
  name: PrometheusPackage;
  runtime: PrometheusRuntime;
}

/** Resolved metric handles. Names are stable; emitters use them by property. */
export interface JetstreamMetrics {
  messagesReceivedTotal: MetricCounter;
  messagesProcessedTotal: MetricCounter;
  messagesUnhandledTotal: MetricCounter;
  messagesDeadLetterTotal: MetricCounter;
  publishTotal: MetricCounter;
  rpcTimeoutTotal: MetricCounter;
  consumerRecoveredTotal: MetricCounter;
  errorsTotal: MetricCounter;
  handlerDurationSeconds: MetricHistogram;
  publishDurationSeconds: MetricHistogram;
  rpcDurationSeconds: MetricHistogram;
  consumerNumPending: MetricGauge;
  consumerNumAckPending: MetricGauge;
  consumerNumRedelivered: MetricGauge;
  consumerNumWaiting: MetricGauge;
  streamMessages: MetricGauge;
  streamBytes: MetricGauge;
  connectionUp: MetricGauge;
  metricsPollErrorsTotal: MetricCounter;
}

export interface CreateMetricsOptions {
  register: MetricsRegistry;
  runtime: PrometheusRuntime;
  prefix?: string;
  defaultLabels?: Record<string, string>;
  buckets?: HistogramBuckets;
}

/** Stream, durable name and StreamKind of a consumer this service owns, used for labelling. */
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

/** Last server a named connection reported, and whether it is currently up. */
export interface ConnectionServerState {
  server: string;
  up: boolean;
}

/** Which end of an RPC gave up: the caller waiting for a reply, or the handler past its deadline. */
export type RpcTimeoutSide = 'client' | 'server';
