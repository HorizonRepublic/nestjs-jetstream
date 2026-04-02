import { FactoryProvider, ModuleMetadata, Type } from '@nestjs/common';
import type { ConnectionOptions } from '@nats-io/transport-node';
import { DeliverPolicy, ReplayPolicy } from '@nats-io/jetstream';
import type { ConsumerConfig, ConsumeOptions, StreamConfig } from '@nats-io/jetstream';

import { Codec } from './codec.interface';
import type { DeadLetterInfo } from './hooks.interface';
import { TransportHooks } from './hooks.interface';

/**
 * Stream config overrides exposed to users.
 *
 * `retention` is excluded because it is controlled by the transport layer
 * (Workqueue for events/commands, Limits for broadcast/ordered).
 * Any `retention` value provided at runtime is silently stripped.
 */
export type StreamConfigOverrides = Partial<Omit<StreamConfig, 'retention'>>;

/**
 * RPC transport configuration.
 *
 * Discriminated union on `mode`:
 * - `'core'`      — NATS native request/reply. Lowest latency.
 * - `'jetstream'`  — Commands persisted in JetStream. Responses via Core NATS inbox.
 *
 * When `mode` is `'core'`, only `timeout` is available.
 * When `mode` is `'jetstream'`, additional stream/consumer overrides are exposed.
 */
export type RpcConfig =
  | {
      mode: 'core';
      /** Request timeout in ms. Default: 30_000. */
      timeout?: number;
    }
  | {
      mode: 'jetstream';
      /** Handler timeout in ms. Default: 180_000 (3 min). */
      timeout?: number;
      /** Raw NATS StreamConfig overrides for the command stream. */
      stream?: StreamConfigOverrides;
      /** Raw NATS ConsumerConfig overrides for the command consumer. */
      consumer?: Partial<ConsumerConfig>;

      /** Options passed to the nats.js `consumer.consume()` call for the command consumer. */
      consume?: Partial<ConsumeOptions>;

      /** Maximum number of concurrent RPC handler executions. */
      concurrency?: number;

      /**
       * Auto-extend ack deadline via `msg.working()` during RPC handler execution.
       * The RPC handler timeout (`setTimeout` + `msg.term()`) still acts as the hard cap.
       */
      ackExtension?: boolean | number;
    };

/** Overrides for JetStream stream and consumer configuration. */
export interface StreamConsumerOverrides {
  stream?: StreamConfigOverrides;
  consumer?: Partial<ConsumerConfig>;

  /**
   * Options passed to the nats.js `consumer.consume()` call.
   * Controls prefetch buffer size, idle heartbeat interval, and auto-refill thresholds.
   *
   * nats.js supports two consumption modes (message-based and byte-based).
   * Do not mix `max_bytes`/`threshold_bytes` with `threshold_messages` —
   * use one mode or the other.
   *
   * @see https://github.com/nats-io/nats.js — ConsumeOptions
   */
  consume?: Partial<ConsumeOptions>;

  /**
   * Maximum number of concurrent handler executions (RxJS `mergeMap` limit).
   *
   * Default: `undefined` (unlimited — naturally bounded by `max_ack_pending`).
   * Set this to protect downstream systems from overload.
   *
   * **Important:** if `concurrency < max_ack_pending`, messages buffer in RxJS
   * while their NATS ack timer ticks. Increase `ack_wait` proportionally to
   * prevent unnecessary redeliveries.
   */
  concurrency?: number;

  /**
   * Auto-extend the NATS ack deadline via `msg.working()` during handler execution.
   *
   * - `false` (default): disabled — NATS redelivers after `ack_wait` if not acked.
   * - `true`: auto-extend at `ack_wait / 2` interval (calculated from consumer config).
   * - `number`: explicit extension interval in milliseconds.
   */
  ackExtension?: boolean | number;
}

/**
 * Configuration for ordered event consumers.
 *
 * Ordered consumers use Limits retention and deliver messages in strict
 * sequential order with at-most-once delivery. No ack/nak/DLQ.
 *
 * Only a subset of consumer options applies — ordered consumers are
 * ephemeral and auto-managed by nats.js.
 */
export interface OrderedEventOverrides {
  /** Stream overrides (e.g. `max_age`, `max_bytes`). */
  stream?: StreamConfigOverrides;

  /**
   * Where to start reading when the consumer is (re)created.
   * @default DeliverPolicy.All
   */
  deliverPolicy?: DeliverPolicy;

  /**
   * Start sequence number. Only used when `deliverPolicy` is `StartSequence`.
   */
  optStartSeq?: number;

  /**
   * Start time (ISO string). Only used when `deliverPolicy` is `StartTime`.
   */
  optStartTime?: string;

  /**
   * Replay policy for historical messages.
   * @default ReplayPolicy.Instant
   */
  replayPolicy?: ReplayPolicy;
}

/**
 * Root module configuration for `JetstreamModule.forRoot()`.
 *
 * Minimal usage requires only `name` and `servers`.
 * All other fields have production-ready defaults.
 */
export interface JetstreamModuleOptions {
  /** Service name. Used for stream/consumer/subject naming. */
  name: string;

  /** NATS server URLs. */
  servers: string[];

  /**
   * Global message codec.
   * @default JsonCodec
   */
  codec?: Codec;

  /**
   * RPC transport mode and configuration.
   * @default { mode: 'core' }
   */
  rpc?: RpcConfig;

  /**
   * Enable consumer infrastructure (streams, consumers, message routing).
   * Set to `false` for publisher-only services (e.g., API gateways).
   * @default true
   */
  consumer?: boolean;

  /** Workqueue event stream/consumer overrides. */
  events?: StreamConsumerOverrides;

  /** Broadcast event stream/consumer overrides. */
  broadcast?: StreamConsumerOverrides;

  /**
   * Ordered event consumer configuration.
   *
   * Ordered events use a separate stream with Limits retention and deliver
   * messages in strict sequential order. Use `ordered:` prefix when publishing.
   *
   * @see OrderedEventOverrides
   */
  ordered?: OrderedEventOverrides;

  /**
   * Transport lifecycle hook handlers.
   * Unset hooks are silently ignored — no default logging.
   */
  hooks?: Partial<TransportHooks>;

  /**
   * Async callback invoked when an event message exhausts all delivery attempts.
   * Called before msg.term(). If it throws, the message is nak'd for retry.
   *
   * Use this to persist dead letters to an external store (DB, S3, another queue).
   * The NATS connection is available via `JETSTREAM_CONNECTION` token in forRootAsync.
   *
   * @example
   * ```typescript
   * JetstreamModule.forRootAsync({
   *   name: 'my-service',
   *   imports: [DlqModule],
   *   inject: [DlqService, JETSTREAM_CONNECTION],
   *   useFactory: (dlqService, connection) => ({
   *     servers: ['nats://localhost:4222'],
   *     onDeadLetter: async (info) => {
   *       await dlqService.persist(info);
   *     },
   *   }),
   * })
   * ```
   */
  onDeadLetter?(info: DeadLetterInfo): Promise<void>;

  /**
   * Graceful shutdown timeout in ms.
   * Handlers exceeding this are abandoned.
   * @default 10_000
   */
  shutdownTimeout?: number;

  /**
   * Allow destructive stream migration when immutable config changes are detected.
   *
   * When `true`, the transport will recreate streams (via blue-green sourcing)
   * if immutable properties like `storage` differ from the running stream.
   * Messages are preserved during migration.
   *
   * `retention` is NOT migratable — it is controlled by the transport
   * (Workqueue for events, Limits for broadcast/ordered) and a mismatch
   * is always treated as an error regardless of this flag.
   *
   * When `false` (default), immutable conflicts are logged as warnings and
   * the stream continues with its existing configuration.
   *
   * @default false
   */
  allowDestructiveMigration?: boolean;

  /**
   * Raw NATS ConnectionOptions pass-through for advanced connection config.
   * Allows setting tls, auth, reconnect behavior, maxReconnectAttempts, etc.
   * Merged with `name` and `servers` — those take precedence.
   */
  connectionOptions?: Partial<ConnectionOptions>;
}

/** Options for `JetstreamModule.forFeature()`. */
export interface JetstreamFeatureOptions {
  /** Target service name for subject construction. */
  name: string;

  /**
   * Override the global codec for this client.
   * Falls back to the root codec from `forRoot()` when omitted.
   */
  codec?: Codec;
}

/**
 * Async configuration for `JetstreamModule.forRootAsync()`.
 *
 * Supports three patterns: `useFactory`, `useExisting`, `useClass`.
 */
export type JetstreamModuleAsyncOptions = {
  /** Service name — required upfront for DI token generation. */
  name: string;

  /** Additional module imports (e.g., ConfigModule). */
  imports?: ModuleMetadata['imports'];
} & (
  | {
      useFactory(
        ...args: unknown[]
      ): Promise<Omit<JetstreamModuleOptions, 'name'>> | Omit<JetstreamModuleOptions, 'name'>;
      inject?: FactoryProvider['inject'];
      useExisting?: never;
      useClass?: never;
    }
  | {
      useExisting: Type<Omit<JetstreamModuleOptions, 'name'>>;
      useFactory?: never;
      inject?: never;
      useClass?: never;
    }
  | {
      useClass: Type<Omit<JetstreamModuleOptions, 'name'>>;
      useFactory?: never;
      inject?: never;
      useExisting?: never;
    }
);
