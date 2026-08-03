import type { ConnectionOptions } from '@nats-io/transport-node';

import type { Codec } from './codec.interface';
import type {
  DlqOptions,
  JetstreamModuleOptions,
  MetadataRegistryOptions,
  OrderedEventOverrides,
  ProvisioningOptions,
  RpcConfig,
  StreamConsumerOverrides,
} from './options.interface';

/**
 * Configuration for one named connection.
 *
 * Every field except `servers` falls back to the root-level value of the same
 * name; setting it here wins for this connection only.
 */
export interface JetstreamConnectionOptions {
  /** NATS server URLs for this connection. */
  servers: string[];

  /**
   * Whether application startup depends on this connection.
   *
   * `true` (default) blocks boot until the connection is live. `false` connects
   * lazily in the background, retries on failure, and reports `degraded` health
   * instead of failing readiness.
   *
   * @default true
   */
  critical?: boolean;

  /** Raw NATS connection options for this connection. */
  connectionOptions?: Partial<ConnectionOptions>;

  /** Codec for this connection; falls back to the root codec. */
  codec?: Codec;

  /** Set to `false` to make this connection publisher-only (no streams, no consumers). */
  consumer?: false;

  /** Workqueue event stream/consumer overrides for this connection. */
  events?: StreamConsumerOverrides;

  /** Broadcast event stream/consumer overrides for this connection. */
  broadcast?: StreamConsumerOverrides;

  /** Ordered event consumer configuration for this connection. */
  ordered?: OrderedEventOverrides;

  /** RPC transport mode and configuration for this connection. */
  rpc?: RpcConfig;

  /** Dead-letter queue configuration for this connection. */
  dlq?: DlqOptions | false;

  /** Handler metadata KV registry configuration for this connection. */
  metadata?: MetadataRegistryOptions;

  /** Provisioning behavior for this connection. */
  provisioning?: ProvisioningOptions;

  /** Allow destructive stream migration for this connection. */
  allowDestructiveMigration?: boolean;

  /** Graceful shutdown budget in ms for this connection. */
  shutdownTimeout?: number;
}

/**
 * A single connection's options after the root/connection merge.
 *
 * Structurally assignable to {@link JetstreamModuleOptions}, so every provider
 * that already accepts the root options accepts a resolved connection unchanged.
 */
export interface ResolvedConnectionOptions extends Omit<
  JetstreamModuleOptions,
  'servers' | 'connections' | 'defaultConnection'
> {
  /** NATS server URLs; always present after normalization. */
  servers: string[];

  /** The connection's name in the `connections` map. */
  connectionName: string;

  /** Resolved criticality; `true` unless explicitly disabled. */
  critical: boolean;
}

/** Result of rewriting module options into the multi-connection form. */
export interface NormalizedConnectionsConfig {
  /** Every configured connection, in declaration order. */
  connections: ResolvedConnectionOptions[];

  /** Name of the connection that unqualified handlers and clients bind to. */
  defaultConnection: string;
}

/** Per-connection entry in the health status breakdown. */
export interface JetstreamConnectionHealth {
  /** Whether this connection is alive. */
  connected: boolean;

  /** Whether readiness depends on this connection. */
  critical: boolean;

  /** NATS server URL, or `null` if not connected. */
  server: string | null;

  /** Round-trip latency in ms, or `null` if disconnected. */
  latency: number | null;
}
