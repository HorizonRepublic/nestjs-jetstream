import { FactoryProvider, ModuleMetadata, Type } from '@nestjs/common';
import { ConnectionOptions, ConsumerConfig, StreamConfig } from 'nats';

import { Codec } from './codec.interface';
import { TransportHooks } from './hooks.interface';

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
      stream?: Partial<StreamConfig>;
      /** Raw NATS ConsumerConfig overrides for the command consumer. */
      consumer?: Partial<ConsumerConfig>;
    };

/** Overrides for JetStream stream and consumer configuration. */
export interface StreamConsumerOverrides {
  stream?: Partial<StreamConfig>;
  consumer?: Partial<ConsumerConfig>;
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
   * Transport lifecycle hook handlers.
   * Unset hooks fall back to NestJS Logger.
   */
  hooks?: Partial<TransportHooks>;

  /**
   * Graceful shutdown timeout in ms.
   * Handlers exceeding this are abandoned.
   * @default 10_000
   */
  shutdownTimeout?: number;

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
