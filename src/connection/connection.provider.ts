import { Logger } from '@nestjs/common';
import {
  connect,
  ConnectionOptions,
  DebugEvents,
  Events,
  type JetStreamClient,
  JetStreamManager,
  NatsConnection,
  NatsError,
  Status,
} from 'nats';
import { defer, from, Observable, share, shareReplay, switchMap } from 'rxjs';

import { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';
import type { JetstreamModuleOptions } from '../interfaces';
import { internalName } from '../jetstream.constants';

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

  public constructor(
    private readonly options: JetstreamModuleOptions,
    private readonly eventBus: EventBus,
  ) {
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

    this.jsmPromise = (async (): Promise<JetStreamManager> => {
      const nc = await this.getConnection();

      this.jsmInstance = await nc.jetstreamManager();
      this.logger.log('JetStream manager initialized');
      return this.jsmInstance;
    })().finally(() => {
      this.jsmPromise = null;
    });

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

    this.jsClient ??= this.connection.jetstream();
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
      await this.connection.drain();
      await this.connection.closed();
    } catch {
      try {
        await this.connection.close();
      } catch {
        // Best-effort — connection may already be gone
      }
    } finally {
      this.connection = null;
      this.connectionPromise = null;
      this.jsClient = null;
      this.jsmInstance = null;
      this.jsmPromise = null;
    }
  }

  /** Internal: establish the physical connection with reconnect monitoring. */
  private async establish(): Promise<NatsConnection> {
    const name = internalName(this.options.name);

    try {
      const nc = await connect({
        ...DEFAULT_OPTIONS,
        ...this.options.connectionOptions,
        servers: this.options.servers,
        name,
      } as ConnectionOptions);

      this.connection = nc;
      this.logger.log(`NATS connection established: ${nc.getServer()}`);
      this.eventBus.emit(TransportEvent.Connect, nc.getServer());

      this.monitorStatus(nc);

      return nc;
    } catch (err) {
      if (err instanceof NatsError && err.code === 'CONNECTION_REFUSED') {
        throw new Error(`NATS connection refused: ${this.options.servers.join(', ')}`);
      }

      throw err;
    }
  }

  /** Subscribe to connection status events and emit hooks. */
  private monitorStatus(nc: NatsConnection): void {
    (async (): Promise<void> => {
      for await (const status of nc.status()) {
        switch (status.type) {
          case Events.Disconnect:
            this.eventBus.emit(TransportEvent.Disconnect);
            break;
          case Events.Reconnect:
            this.jsClient = null;
            this.jsmInstance = null;
            this.jsmPromise = null;
            this.eventBus.emit(TransportEvent.Reconnect, nc.getServer());
            break;
          case Events.Error:
            this.eventBus.emit(TransportEvent.Error, new Error(String(status.data)), 'connection');
            break;
          case Events.Update:
          case Events.LDM:
          case DebugEvents.Reconnecting:
          case DebugEvents.PingTimer:
          case DebugEvents.StaleConnection:
          case DebugEvents.ClientInitiatedReconnect:
            break;
        }
      }
    })().catch((err) => {
      this.logger.error('Status monitor error', err);
    });
  }
}
