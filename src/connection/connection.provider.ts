import { Logger } from '@nestjs/common';
import {
  connect,
  type ConnectionOptions,
  type NatsConnection,
  type Status,
} from '@nats-io/transport-node';
import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
} from '@nats-io/jetstream';
import { defer, from, Observable, share, shareReplay, switchMap } from 'rxjs';

import { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';
import type { JetstreamModuleOptions } from '../interfaces';
import {
  ATTR_NATS_CONNECTION_SERVER,
  beginConnectionLifecycleSpan,
  deriveOtelAttrs,
  EVENT_CONNECTION_DISCONNECTED,
  EVENT_CONNECTION_RECONNECTED,
  withShutdownSpan,
  type ConnectionLifecycleSpanHandle,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../otel';

const DEFAULT_OPTIONS: Partial<ConnectionOptions> = {
  maxReconnectAttempts: -1,
  reconnectTimeWait: 1_000,
};

/**
 * Manages the lifecycle of a single NATS connection shared across the application.
 *
 * Provides both Promise-based and Observable-based access to the connection:
 * - `connect()` / `getConnection()` — async/await for one-time setup
 * - `nc$` — cached observable (shareReplay) for reactive consumers
 * - `status$` — live connection status event stream
 *
 * One instance per application, created by `JetstreamModule.forRoot()`.
 */
export class ConnectionProvider {
  /** Cached observable that replays the established connection to new subscribers. */
  public readonly nc$: Observable<NatsConnection>;

  /** Live stream of connection status events (no replay). */
  public readonly status$: Observable<Status>;

  private readonly logger = new Logger('Jetstream:Connection');

  private connection: NatsConnection | null = null;
  private connectionPromise: Promise<NatsConnection> | null = null;
  private jsClient: JetStreamClient | null = null;
  private jsmInstance: JetStreamManager | null = null;
  private jsmPromise: Promise<JetStreamManager> | null = null;

  private readonly otel: ResolvedOtelOptions;
  private readonly otelServiceName: string;
  private readonly otelEndpoint: ServerEndpoint | null;
  private lifecycleSpan: ConnectionLifecycleSpanHandle | null = null;

  public constructor(
    private readonly options: JetstreamModuleOptions,
    private readonly eventBus: EventBus,
  ) {
    const derived = deriveOtelAttrs(options);

    this.otel = derived.otel;
    this.otelServiceName = derived.serviceName;
    this.otelEndpoint = derived.serverEndpoint;
    // Lazy observable — connects on first subscription, caches for all future subscribers
    this.nc$ = defer(() => this.getConnection()).pipe(
      shareReplay({ bufferSize: 1, refCount: false }),
    );

    this.status$ = this.nc$.pipe(
      switchMap((nc) => from(nc.status())),
      share(),
    );
  }

  /**
   * Establish NATS connection. Idempotent — returns cached connection on subsequent calls.
   *
   * @throws Error if connection is refused (fail fast).
   */
  public async getConnection(): Promise<NatsConnection> {
    if (this.connection && !this.connection.isClosed()) {
      return this.connection;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.establish().catch((err) => {
      this.connectionPromise = null;
      throw err;
    });

    return this.connectionPromise;
  }

  /**
   * Get the JetStream manager. Cached after first call.
   *
   * @returns The JetStreamManager for stream/consumer administration.
   */
  public async getJetStreamManager(): Promise<JetStreamManager> {
    if (this.jsmInstance) return this.jsmInstance;
    if (this.jsmPromise) return this.jsmPromise;

    this.jsmPromise = this.initJetStreamManager();

    return this.jsmPromise;
  }

  /**
   * Get a cached JetStream client.
   *
   * Invalidated automatically on reconnect and shutdown so consumers always
   * operate against the live connection.
   *
   * @returns The cached JetStreamClient.
   * @throws Error if the connection has not been established yet.
   */
  public getJetStreamClient(): JetStreamClient {
    if (!this.connection || this.connection.isClosed()) {
      throw new Error('Not connected — call getConnection() before getJetStreamClient()');
    }

    this.jsClient ??= jetstream(this.connection);
    return this.jsClient;
  }

  /** Direct access to the raw NATS connection, or `null` if not yet connected. */
  public get unwrap(): NatsConnection | null {
    return this.connection;
  }

  /**
   * Gracefully shut down the connection.
   *
   * Sequence: drain → wait for close. Falls back to force-close on error.
   */
  public async shutdown(): Promise<void> {
    // Wait for in-flight connection to settle so it doesn't escape shutdown
    if (this.connectionPromise) {
      try {
        await this.connectionPromise;
      } catch {
        // Connection failed — nothing to shut down
      }
    }

    if (!this.connection || this.connection.isClosed()) return;

    try {
      await withShutdownSpan(
        this.otel,
        { serviceName: this.otelServiceName, endpoint: this.otelEndpoint },
        async () => {
          try {
            await this.connection?.drain();
            await this.connection?.closed();
          } catch {
            try {
              await this.connection?.close();
            } catch {
              // Best-effort — connection may already be gone
            }
          }
        },
      );
    } finally {
      this.lifecycleSpan?.finish();
      this.lifecycleSpan = null;
      this.connection = null;
      this.connectionPromise = null;
      this.jsClient = null;
      this.jsmInstance = null;
      this.jsmPromise = null;
    }
  }

  private async initJetStreamManager(): Promise<JetStreamManager> {
    try {
      const nc = await this.getConnection();

      this.jsmInstance = await jetstreamManager(nc);
      this.logger.log('JetStream manager initialized');

      return this.jsmInstance;
    } finally {
      this.jsmPromise = null;
    }
  }

  /** Internal: establish the physical connection with reconnect monitoring. */
  private async establish(): Promise<NatsConnection> {
    try {
      const nc = await connect({
        ...DEFAULT_OPTIONS,
        ...this.options.connectionOptions,
        servers: this.options.servers,
        name: this.otelServiceName,
      } as ConnectionOptions);

      this.connection = nc;
      this.logger.log(`NATS connection established: ${nc.getServer()}`);
      this.eventBus.emit(TransportEvent.Connect, nc.getServer());

      // Close any prior lifecycle span (rare re-establish path after the
      // underlying connection reported isClosed()) before starting a new one.
      this.lifecycleSpan?.finish();
      this.lifecycleSpan = beginConnectionLifecycleSpan(this.otel, {
        serviceName: this.otelServiceName,
        endpoint: this.otelEndpoint,
        server: nc.getServer(),
      });

      this.monitorStatus(nc);

      return nc;
    } catch (err) {
      if (err instanceof Error && err.message.includes('REFUSED')) {
        throw new Error(`NATS connection refused: ${this.options.servers.join(', ')}`);
      }

      throw err;
    }
  }

  /** Handle a single `nc.status()` event, emitting hooks and span events. */
  private handleStatusEvent(status: Status, nc: NatsConnection): void {
    switch (status.type) {
      case 'disconnect':
        this.eventBus.emit(TransportEvent.Disconnect);
        this.lifecycleSpan?.recordEvent(EVENT_CONNECTION_DISCONNECTED);
        break;
      case 'reconnect':
        this.jsClient = null;
        this.jsmInstance = null;
        this.jsmPromise = null;
        this.eventBus.emit(TransportEvent.Reconnect, nc.getServer());
        this.lifecycleSpan?.recordEvent(EVENT_CONNECTION_RECONNECTED, {
          [ATTR_NATS_CONNECTION_SERVER]: nc.getServer(),
        });
        break;
      case 'error':
        this.eventBus.emit(
          TransportEvent.Error,
          (status as { type: 'error'; error: Error }).error,
          'connection',
        );
        break;
      case 'update':
      case 'ldm':
      case 'reconnecting':
      case 'ping':
      case 'staleConnection':
      case 'forceReconnect':
      case 'slowConsumer':
      case 'close':
        break;
      default: {
        // Exhaustiveness guard — new `Status.type` values added by
        // `@nats-io/transport-node` upgrades surface as TS errors here
        // instead of being silently ignored. Runtime still logs the
        // unknown tag for operator visibility.
        const _exhaustive: never = status;
        const unknown = (_exhaustive as { type?: string }).type ?? 'unknown';

        this.logger.warn(`Unhandled NATS status event: ${unknown}`);
      }
    }
  }

  /** Subscribe to connection status events and emit hooks. */
  private monitorStatus(nc: NatsConnection): void {
    void (async (): Promise<void> => {
      try {
        for await (const status of nc.status()) {
          this.handleStatusEvent(status, nc);
        }
      } finally {
        // Iterator exited — connection is terminally closed (shutdown,
        // server-initiated close, reconnect budget exhausted). Finalize the
        // lifecycle span here so it does not linger as an open parent for the
        // remaining process uptime. `shutdown()` races with this but both
        // finishes are idempotent.
        this.lifecycleSpan?.finish();
        this.lifecycleSpan = null;
      }
    })().catch((err) => {
      this.logger.error('Status monitor error', err);
    });
  }
}
