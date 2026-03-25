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
 * Generate the injection token for a `forFeature()` client.
 *
 * Use with `@Inject()` to inject the client created by `JetstreamModule.forFeature()`.
 *
 * @param name - The service name passed to `forFeature({ name })`.
 * @returns The DI token string.
 *
 * @example
 * ```typescript
 * @Inject(getClientToken('orders'))
 * private readonly ordersClient: JetstreamClient;
 * ```
 */
export const getClientToken = (name: string): string => name;

// ---------------------------------------------------------------------------
// Size & Time Helpers
// ---------------------------------------------------------------------------

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** Supported time units for {@link toNanos}. */
type TimeUnit = 'ms' | 'seconds' | 'minutes' | 'hours' | 'days';

const NANOS_PER: Record<TimeUnit, number> = {
  ms: 1_000_000,
  seconds: 1_000_000_000,
  minutes: 60_000_000_000,
  hours: 3_600_000_000_000,
  days: 86_400_000_000_000,
};

/**
 * Convert a human-readable duration to nanoseconds (NATS JetStream format).
 *
 * @param value - Numeric duration value.
 * @param unit - Time unit to convert from.
 * @returns Duration in nanoseconds.
 *
 * @example
 * ```typescript
 * { ack_wait: toNanos(30, 'seconds') }
 * { max_age: toNanos(7, 'days') }
 * { duplicate_window: toNanos(2, 'minutes') }
 * ```
 */
export const toNanos = (value: number, unit: TimeUnit): number => value * NANOS_PER[unit];

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
  compression: StoreCompression.S2,
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
  max_age: toNanos(7, 'days'),
  duplicate_window: toNanos(2, 'minutes'),
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
  max_age: toNanos(3, 'minutes'),
  duplicate_window: toNanos(30, 'seconds'),
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
  max_age: toNanos(1, 'days'),
  duplicate_window: toNanos(2, 'minutes'),
};

/** Default config for ordered event streams (Limits retention). */
export const DEFAULT_ORDERED_STREAM_CONFIG: Partial<StreamConfig> = {
  ...baseStreamConfig,
  retention: RetentionPolicy.Limits,
  allow_rollup_hdrs: false,
  max_consumers: 100,
  max_msg_size: 10 * MB,
  max_msgs_per_subject: 5_000_000,
  max_msgs: 50_000_000,
  max_bytes: 5 * GB,
  max_age: toNanos(1, 'days'),
  duplicate_window: toNanos(2, 'minutes'),
};

// ---------------------------------------------------------------------------
// Default Consumer Configurations
// ---------------------------------------------------------------------------

/** Default config for workqueue event consumers. */
export const DEFAULT_EVENT_CONSUMER_CONFIG: Partial<ConsumerConfig> = {
  ack_wait: toNanos(10, 'seconds'),
  max_deliver: 3,
  max_ack_pending: 100,
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
  replay_policy: ReplayPolicy.Instant,
};

/** Default config for RPC command consumers (jetstream mode only). */
export const DEFAULT_COMMAND_CONSUMER_CONFIG: Partial<ConsumerConfig> = {
  ack_wait: toNanos(5, 'minutes'),
  max_deliver: 1,
  max_ack_pending: 100,
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
  replay_policy: ReplayPolicy.Instant,
};

/** Default config for broadcast event consumers. */
export const DEFAULT_BROADCAST_CONSUMER_CONFIG: Partial<ConsumerConfig> = {
  ack_wait: toNanos(10, 'seconds'),
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

/** Default RPC timeout for Core mode (30 seconds). */
export const DEFAULT_RPC_TIMEOUT = 30_000;

/** Default RPC timeout for JetStream mode (3 minutes). */
export const DEFAULT_JETSTREAM_RPC_TIMEOUT = 180_000;

/** Default graceful shutdown timeout (10 seconds). */
export const DEFAULT_SHUTDOWN_TIMEOUT = 10_000;

// ---------------------------------------------------------------------------
// Reserved Headers
// ---------------------------------------------------------------------------

/**
 * NATS headers managed by the transport.
 *
 * These headers are set automatically on outbound messages.
 * Some are reserved ({@link RESERVED_HEADERS}) and cannot be overwritten
 * via `JetstreamRecordBuilder.setHeader()`.
 */
export enum JetstreamHeader {
  /** Unique ID linking an RPC request to its response. */
  CorrelationId = 'x-correlation-id',
  /** Inbox subject where the RPC response should be published. */
  ReplyTo = 'x-reply-to',
  /** Original subject the message was published to. */
  Subject = 'x-subject',
  /** Internal name of the service that sent the message. */
  CallerName = 'x-caller-name',
  /** Set to `'true'` on error responses so the client can distinguish success from failure. */
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

/**
 * Build the internal service name with microservice suffix.
 *
 * @param name - Service name from `forRoot({ name })`.
 * @returns `{name}__microservice`
 */
export const internalName = (name: string): string => `${name}__microservice`;

/**
 * Build a fully-qualified NATS subject for workqueue events, RPC commands, or ordered events.
 *
 * @param serviceName - Target service name.
 * @param kind - Subject kind (`'ev'`, `'cmd'`, or `'ordered'`).
 * @param pattern - The message pattern (e.g. `'user.created'`).
 * @returns `{serviceName}__microservice.{kind}.{pattern}`
 */
export const buildSubject = (serviceName: string, kind: SubjectKind, pattern: string): string =>
  `${internalName(serviceName)}.${kind}.${pattern}`;

/**
 * Build a broadcast subject.
 *
 * @param pattern - The message pattern (e.g. `'config.updated'`).
 * @returns `broadcast.{pattern}`
 */
export const buildBroadcastSubject = (pattern: string): string => `broadcast.${pattern}`;

/**
 * Build the JetStream stream name for a given service and kind.
 *
 * @param serviceName - Service name from `forRoot({ name })`.
 * @param kind - Stream kind (`'ev'`, `'cmd'`, or `'broadcast'`).
 * @returns Stream name (e.g. `orders__microservice_ev-stream` or `broadcast-stream`).
 */
export const streamName = (serviceName: string, kind: StreamKind): string => {
  if (kind === 'broadcast') return 'broadcast-stream';
  return `${internalName(serviceName)}_${kind}-stream`;
};

/**
 * Build the JetStream consumer name for a given service and kind.
 *
 * @param serviceName - Service name from `forRoot({ name })`.
 * @param kind - Stream kind (`'ev'`, `'cmd'`, or `'broadcast'`).
 * @returns Consumer name (e.g. `orders__microservice_ev-consumer`).
 */
export const consumerName = (serviceName: string, kind: StreamKind): string => {
  if (kind === 'broadcast') return `${internalName(serviceName)}_broadcast-consumer`;
  return `${internalName(serviceName)}_${kind}-consumer`;
};
