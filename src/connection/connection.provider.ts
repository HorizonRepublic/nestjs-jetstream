import { Logger } from '@nestjs/common';

import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
} from '@nats-io/jetstream';
import {
  connect,
  type ConnectionOptions,
  type NatsConnection,
  type Status,
} from '@nats-io/transport-node';

import { defer, from, Observable, ReplaySubject, share, Subject, switchMap } from 'rxjs';

import { ConnectionErrorReason, JetstreamConnectionError } from '../errors';
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
import { ServerCapabilities } from './server-capabilities';

const DEFAULT_OPTIONS: Partial<ConnectionOptions> = {
  maxReconnectAttempts: -1,
  reconnectTimeWait: 1_000,
};

/**
 * Manages the lifecycle of a single NATS connection shared across the application.
 *
 * Provides both Promise-based and Observable-based access to the connection:
 * - `connect()` / `getConnection()`: async/await for one-time setup
 * - `nc$`: replays the current connection and every one established after it
 * - `status$`: live status events of whichever connection is current
 *
 * One instance per application, created by `JetstreamModule.forRoot()`.
 */
export class ConnectionProvider {
  /**
   * Connects on first subscription, then emits the current connection and each
   * one established after a terminal close.
   */
  public readonly nc$: Observable<NatsConnection>;

  /** Live status events (no replay), following the connection across re-establishment. */
  public readonly status$: Observable<Status>;

  private readonly logger = new Logger('Jetstream:Connection');

  private connection: NatsConnection | null = null;
  private readonly established = new ReplaySubject<NatsConnection>(1);
  private readonly reconnected = new Subject<void>();
  private connectionPromise: Promise<NatsConnection> | null = null;
  private jsClient: JetStreamClient | null = null;
  private jsmInstance: JetStreamManager | null = null;
  private jsmPromise: Promise<JetStreamManager> | null = null;
  private capabilitiesPromise: Promise<ServerCapabilities> | null = null;

  private readonly otel: ResolvedOtelOptions;
  private readonly otelServiceName: string;
  private readonly otelEndpoint: ServerEndpoint | null;
  private lifecycleSpan: ConnectionLifecycleSpanHandle | null = null;
  private serverBound = false;
  private serverConnectionLost = false;
  private shuttingDown = false;

  public constructor(
    private readonly options: JetstreamModuleOptions,
    private readonly eventBus: EventBus,
  ) {
    const derived = deriveOtelAttrs(options);

    this.otel = derived.otel;
    this.otelServiceName = derived.serviceName;
    this.otelEndpoint = derived.serverEndpoint;
    this.nc$ = defer(async () => this.getConnection()).pipe(switchMap(() => this.established));

    this.status$ = this.nc$.pipe(
      switchMap((nc) => from(nc.status())),
      share(),
    );
  }

  /**
   * Establish NATS connection. Idempotent: returns cached connection on subsequent calls.
   *
   * @throws Error if connection is refused (fail fast).
   * @throws JetstreamConnectionError with reason `shutting-down` once {@link shutdown} has begun.
   */
  public async getConnection(): Promise<NatsConnection> {
    // A late emit or send must not open a connection that nothing will close.
    if (this.shuttingDown) {
      throw new JetstreamConnectionError(
        ConnectionErrorReason.ShuttingDown,
        'The transport is shutting down; no new connection is opened',
      );
    }

    if (this.connection && !this.connection.isClosed()) {
      return this.connection;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // Cleared once settled: after a terminal close the next call must dial again.
    this.connectionPromise = this.establish().finally(() => {
      this.connectionPromise = null;
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
   * What the connected JetStream supports, probed once per connection and
   * again after a reconnect, which may land on a server of another version.
   */
  public async getCapabilities(): Promise<ServerCapabilities> {
    this.capabilitiesPromise ??= this.probeCapabilities();

    return this.capabilitiesPromise;
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
      throw new JetstreamConnectionError(
        ConnectionErrorReason.NotConnected,
        'Not connected; call getConnection() before getJetStreamClient()',
      );
    }

    this.jsClient ??= jetstream(this.connection);
    return this.jsClient;
  }

  /**
   * Record that a server (consumers, RPC subscriptions, advisories) runs on
   * this connection. Those are not rebuilt on a re-dialled connection.
   */
  public bindServer(): void {
    this.serverBound = true;
  }

  /**
   * True once a connection that a server was bound to closed for good outside
   * of {@link shutdown}. Sticky: re-dialling recovers clients only, so health
   * keeps reporting the connection down until the process restarts.
   */
  public hasLostServerConnection(): boolean {
    return this.serverConnectionLost;
  }

  /** Emits each time the connection comes back after a disconnect. */
  public get reconnects$(): Observable<void> {
    return this.reconnected.asObservable();
  }

  /** Direct access to the raw NATS connection, or `null` if not yet connected. */
  public get unwrap(): NatsConnection | null {
    return this.connection;
  }

  /**
   * Gracefully shut down the connection.
   *
   * Sequence: drain -> wait for close. Falls back to force-close on error.
   */
  public async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Wait for in-flight connection to settle so it doesn't escape shutdown
    if (this.connectionPromise) {
      try {
        await this.connectionPromise;
      } catch {
        // Connection failed; nothing to shut down
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
              // Best-effort; connection may already be gone
            }
          }
        },
      );
    } finally {
      this.lifecycleSpan?.finish();
      this.lifecycleSpan = null;
      this.connection = null;
      this.connectionPromise = null;
      this.resetConnectionCaches();
    }
  }

  /**
   * Close the connection at once, without draining. Ends a {@link shutdown}
   * whose drain outlived the shutdown budget; unflushed publishes are lost.
   */
  public async forceClose(): Promise<void> {
    const nc = this.connection;

    if (!nc || nc.isClosed()) return;

    try {
      await nc.close();
    } catch {
      // Best-effort; the connection may already be gone
    }
  }

  /** Drop everything bound to a particular connection or server. */
  private resetConnectionCaches(): void {
    this.jsClient = null;
    this.jsmInstance = null;
    this.jsmPromise = null;
    this.capabilitiesPromise = null;
  }

  private async probeCapabilities(): Promise<ServerCapabilities> {
    try {
      return await ServerCapabilities.probe(
        await this.getConnection(),
        await this.getJetStreamManager(),
      );
    } catch (err) {
      this.capabilitiesPromise = null;
      throw err;
    }
  }

  private async initJetStreamManager(): Promise<JetStreamManager> {
    try {
      const nc = await this.getConnection();
      const jsm = await jetstreamManager(nc);

      if (this.connection === nc) this.jsmInstance = jsm;
      this.logger.log('JetStream manager initialized');

      return jsm;
    } finally {
      this.jsmPromise = null;
    }
  }

  /** Internal: establish the physical connection with reconnect monitoring. */
  private async establish(): Promise<NatsConnection> {
    try {
      const nc = await connect({
        ...DEFAULT_OPTIONS,
        // Default the NATS connection name to the OTel-derived service name so
        // `nats server info` lines up with span attributes, but let user-supplied
        // `connectionOptions.name` win when set.
        name: this.otelServiceName,
        ...this.options.connectionOptions,
        servers: this.options.servers,
      } as ConnectionOptions);

      const previous = this.connection;

      this.connection = nc;
      // Replacing a closed connection; a first dial keeps lookups already waiting on it.
      if (previous) this.resetConnectionCaches();
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
      this.established.next(nc);

      return nc;
    } catch (err) {
      if (err instanceof Error && /refused/i.test(err.message)) {
        throw new JetstreamConnectionError(
          ConnectionErrorReason.Refused,
          `NATS connection refused: ${(this.options.servers ?? []).join(', ')}`,
          {
            cause: err,
          },
        );
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
        this.resetConnectionCaches();
        this.eventBus.emit(TransportEvent.Reconnect, nc.getServer());
        this.reconnected.next();
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
        // Exhaustiveness guard: new `Status.type` values added by
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
        // Iterator exited: connection is terminally closed (shutdown,
        // server-initiated close, reconnect budget exhausted). Finalize the
        // lifecycle span here so it does not linger as an open parent for the
        // remaining process uptime. `shutdown()` races with this but both
        // finishes are idempotent. A successor connection owns its own span.
        if (this.connection === nc) {
          this.lifecycleSpan?.finish();
          this.lifecycleSpan = null;
        }

        if (this.serverBound && !this.shuttingDown && !this.serverConnectionLost) {
          this.serverConnectionLost = true;
          this.logger.error(
            'NATS connection closed for good while serving handlers; ' +
              'health reports it down until the process restarts',
          );
        }
      }
    })().catch((err) => {
      this.logger.error('Status monitor error', err);
    });
  }
}
