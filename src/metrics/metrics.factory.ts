import type { Counter, Gauge, Histogram } from 'prom-client';

import { DEFAULT_HISTOGRAM_BUCKETS, DEFAULT_METRICS_PREFIX } from './metrics.constants';
import type { CreateMetricsOptions, JetstreamMetrics } from './metrics.types';

/** Instantiate every Jetstream metric on the given registry. */
export const createMetrics = (opts: CreateMetricsOptions): JetstreamMetrics => {
  const { register, promClient } = opts;
  const prefix = opts.prefix ?? DEFAULT_METRICS_PREFIX;
  const buckets = {
    handlerDuration: opts.buckets?.handlerDuration ?? DEFAULT_HISTOGRAM_BUCKETS.handlerDuration,
    publishDuration: opts.buckets?.publishDuration ?? DEFAULT_HISTOGRAM_BUCKETS.publishDuration,
    rpcDuration: opts.buckets?.rpcDuration ?? DEFAULT_HISTOGRAM_BUCKETS.rpcDuration,
  };

  if (opts.defaultLabels && Object.keys(opts.defaultLabels).length > 0) {
    register.setDefaultLabels(opts.defaultLabels);
  }

  const counter = (name: string, help: string, labelNames: string[]): Counter<string> =>
    new promClient.Counter({ name: `${prefix}${name}`, help, labelNames, registers: [register] });

  const histogram = (
    name: string,
    help: string,
    labelNames: string[],
    bucketArr: number[],
  ): Histogram<string> =>
    new promClient.Histogram({
      name: `${prefix}${name}`,
      help,
      labelNames,
      buckets: bucketArr,
      registers: [register],
    });

  const gauge = (name: string, help: string, labelNames: string[]): Gauge<string> =>
    new promClient.Gauge({ name: `${prefix}${name}`, help, labelNames, registers: [register] });

  return {
    messagesReceivedTotal: counter(
      'messages_received_total',
      'Total messages routed to a handler.',
      ['stream', 'subject', 'kind'],
    ),
    messagesProcessedTotal: counter(
      'messages_processed_total',
      'Total messages whose handler completed.',
      ['stream', 'subject', 'kind', 'status'],
    ),
    messagesUnhandledTotal: counter(
      'messages_unhandled_total',
      'Messages received but not matching any registered handler.',
      ['subject'],
    ),
    messagesDeadLetterTotal: counter(
      'messages_dead_letter_total',
      'Messages routed to dead-letter after exhausting redelivery attempts.',
      ['stream', 'subject'],
    ),
    publishTotal: counter(
      'publish_total',
      'Total publish/send operations performed by the client.',
      ['subject', 'kind', 'status'],
    ),
    rpcTimeoutTotal: counter('rpc_timeout_total', 'RPC calls that exceeded the timeout deadline.', [
      'subject',
    ]),
    consumerRecoveredTotal: counter(
      'consumer_recovered_total',
      'Self-healing recoveries after consume-loop failures.',
      ['kind'],
    ),
    errorsTotal: counter('errors_total', 'Transport-level errors emitted on the EventBus.', [
      'context',
    ]),
    handlerDurationSeconds: histogram(
      'handler_duration_seconds',
      'Wall-clock duration of handler execution.',
      ['stream', 'subject', 'kind', 'status'],
      buckets.handlerDuration,
    ),
    publishDurationSeconds: histogram(
      'publish_duration_seconds',
      'Wall-clock duration of client publish/send operations.',
      ['subject', 'kind', 'status'],
      buckets.publishDuration,
    ),
    rpcDurationSeconds: histogram(
      'rpc_duration_seconds',
      'Wall-clock duration of RPC round-trips from client perspective.',
      ['subject', 'status'],
      buckets.rpcDuration,
    ),
    consumerNumPending: gauge(
      'consumer_num_pending',
      'Messages not yet delivered to this consumer.',
      ['stream', 'consumer', 'kind'],
    ),
    consumerNumAckPending: gauge(
      'consumer_num_ack_pending',
      'Messages delivered but not yet acked.',
      ['stream', 'consumer', 'kind'],
    ),
    consumerNumRedelivered: gauge(
      'consumer_num_redelivered',
      'Messages currently in redelivery state.',
      ['stream', 'consumer', 'kind'],
    ),
    consumerNumWaiting: gauge(
      'consumer_num_waiting',
      'Pull-request waiting count for this consumer.',
      ['stream', 'consumer', 'kind'],
    ),
    streamMessages: gauge('stream_messages', 'Total messages stored in this stream.', ['stream']),
    streamBytes: gauge('stream_bytes', 'Total bytes stored in this stream.', ['stream']),
    connectionUp: gauge('connection_up', 'NATS connection state (1 connected, 0 disconnected).', [
      'server',
    ]),
    metricsPollErrorsTotal: counter(
      'metrics_poll_errors_total',
      'Errors encountered while polling JetStreamManager for gauge data.',
      ['target'],
    ),
  };
};
