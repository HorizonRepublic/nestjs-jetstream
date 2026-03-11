import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  StoreCompression,
} from 'nats';
import type { ConsumerConfig, StreamConfig } from 'nats';

import type { StreamKind, SubjectKind } from './interfaces';

// ---------------------------------------------------------------------------
// Injection Tokens
// ---------------------------------------------------------------------------

/** Token for the resolved JetstreamModuleOptions. */
export const JETSTREAM_OPTIONS = Symbol('JETSTREAM_OPTIONS');

/** Token for the shared ConnectionProvider instance. */
export const JETSTREAM_CONNECTION = Symbol('JETSTREAM_CONNECTION');

/** Token for the global Codec instance. */
export const JETSTREAM_CODEC = Symbol('JETSTREAM_CODEC');

/** Token for the EventBus instance. */
export const JETSTREAM_EVENT_BUS = Symbol('JETSTREAM_EVENT_BUS');

/**
 * Generate a unique injection token for a forFeature client.
 * This is what users inject with `@Inject('service-name')`.
 */
export const getClientToken = (name: string): string => name;

// ---------------------------------------------------------------------------
// Size & Time Helpers
// ---------------------------------------------------------------------------

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** Convert milliseconds to nanoseconds (NATS JetStream format). */
export const nanos = (ms: number): number => ms * 1_000_000;

// ---------------------------------------------------------------------------
// Default Stream Configurations
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/naming-convention -- NATS API uses snake_case property names */

/** Base stream config shared by all stream types. */
const baseStreamConfig: Partial<StreamConfig> = {
  retention: RetentionPolicy.Workqueue,
  storage: StorageType.File,
  num_replicas: 1,
  discard: DiscardPolicy.Old,
  allow_direct: true,
  compression: StoreCompression.None,
};

/** Default config for workqueue event streams. */
export const DEFAULT_EVENT_STREAM_CONFIG: Partial<StreamConfig> = {
  ...baseStreamConfig,
  allow_rollup_hdrs: true,
  max_consumers: 100,
  max_msg_size: 10 * MB,
  max_msgs_per_subject: 5_000_000,
  max_msgs: 50_000_000,
  max_bytes: 5 * GB,
  max_age: nanos(7 * 24 * 60 * 60 * 1000), // 7 days
  duplicate_window: nanos(2 * 60 * 1000), // 2 min
};

/** Default config for RPC command streams (jetstream mode only). */
export const DEFAULT_COMMAND_STREAM_CONFIG: Partial<StreamConfig> = {
  ...baseStreamConfig,
  allow_rollup_hdrs: false,
  max_consumers: 50,
  max_msg_size: 5 * MB,
  max_msgs_per_subject: 100_000,
  max_msgs: 1_000_000,
  max_bytes: 100 * MB,
  max_age: nanos(3 * 60 * 1000), // 3 min
  duplicate_window: nanos(30 * 1000), // 30s
};

/** Default config for broadcast event streams. */
export const DEFAULT_BROADCAST_STREAM_CONFIG: Partial<StreamConfig> = {
  ...baseStreamConfig,
  retention: RetentionPolicy.Limits,
  allow_rollup_hdrs: true,
  max_consumers: 200,
  max_msg_size: 10 * MB,
  max_msgs_per_subject: 1_000_000,
  max_msgs: 10_000_000,
  max_bytes: 2 * GB,
  max_age: nanos(24 * 60 * 60 * 1000), // 1 day
  duplicate_window: nanos(2 * 60 * 1000), // 2 min
};

// ---------------------------------------------------------------------------
// Default Consumer Configurations
// ---------------------------------------------------------------------------

/** Default config for workqueue event consumers. */
export const DEFAULT_EVENT_CONSUMER_CONFIG: Partial<ConsumerConfig> = {
  ack_wait: nanos(10 * 1000), // 10s
  max_deliver: 3,
  max_ack_pending: 100,
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
  replay_policy: ReplayPolicy.Instant,
};

/** Default config for RPC command consumers (jetstream mode only). */
export const DEFAULT_COMMAND_CONSUMER_CONFIG: Partial<ConsumerConfig> = {
  ack_wait: nanos(5 * 60 * 1000), // 5 min
  max_deliver: 1,
  max_ack_pending: 100,
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
  replay_policy: ReplayPolicy.Instant,
};

/** Default config for broadcast event consumers. */
export const DEFAULT_BROADCAST_CONSUMER_CONFIG: Partial<ConsumerConfig> = {
  ack_wait: nanos(10 * 1000), // 10s
  max_deliver: 3,
  max_ack_pending: 100,
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
  replay_policy: ReplayPolicy.Instant,
};

/* eslint-enable @typescript-eslint/naming-convention */

// ---------------------------------------------------------------------------
// Default Module Options
// ---------------------------------------------------------------------------

export const DEFAULT_RPC_TIMEOUT = 30_000; // 30s for core mode

export const DEFAULT_JETSTREAM_RPC_TIMEOUT = 180_000; // 3 min for jetstream mode

export const DEFAULT_SHUTDOWN_TIMEOUT = 10_000; // 10s

// ---------------------------------------------------------------------------
// Reserved Headers
// ---------------------------------------------------------------------------

/** NATS headers managed by the transport. Users cannot overwrite these. */
export enum JetstreamHeader {
  CorrelationId = 'x-correlation-id',
  ReplyTo = 'x-reply-to',
  Subject = 'x-subject',
  CallerName = 'x-caller-name',
  RequestId = 'x-request-id',
  TraceId = 'x-trace-id',
  SpanId = 'x-span-id',
  /** Set to 'true' on error responses so the client can distinguish success from failure. */
  Error = 'x-error',
}

/** Set of header names that are reserved and cannot be set by users. */
export const RESERVED_HEADERS = new Set<string>([
  JetstreamHeader.CorrelationId,
  JetstreamHeader.ReplyTo,
  JetstreamHeader.Error,
]);

// ---------------------------------------------------------------------------
// Naming Helpers
// ---------------------------------------------------------------------------

/** Internal service name with microservice suffix. */
export const internalName = (name: string): string => `${name}__microservice`;

/** Build a fully-qualified NATS subject. */
export const buildSubject = (serviceName: string, kind: SubjectKind, pattern: string): string =>
  `${internalName(serviceName)}.${kind}.${pattern}`;

/** Build a broadcast subject. */
export const buildBroadcastSubject = (pattern: string): string => `broadcast.${pattern}`;

/** Stream name for a given service and kind. */
export const streamName = (serviceName: string, kind: StreamKind): string => {
  if (kind === 'broadcast') return 'broadcast-stream';
  return `${internalName(serviceName)}_${kind}-stream`;
};

/** Consumer name for a given service and kind. */
export const consumerName = (serviceName: string, kind: StreamKind): string => {
  if (kind === 'broadcast') return `${internalName(serviceName)}_broadcast-consumer`;
  return `${internalName(serviceName)}_${kind}-consumer`;
};
