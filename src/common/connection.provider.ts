import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RuntimeException } from '@nestjs/core/errors/exceptions';
import {
  connect,
  ConnectionOptions,
  JetStreamManager,
  NatsConnection,
  NatsError,
  Status,
} from 'nats';
import {
  catchError,
  EMPTY,
  from,
  iif,
  Observable,
  of,
  share,
  shareReplay,
  Subscription,
  switchMap,
  take,
  tap,
} from 'rxjs';

import { IJetstreamTransportOptions } from './types';

/**
 * Provider that manages the lifecycle of a NATS connection and JetStream manager.
 *
 * @description
 * This provider is responsible for establishing and maintaining a connection to NATS servers,
 * providing access to the JetStream manager, and handling connection lifecycle events.
 * It serves as the foundation for all NATS JetStream operations in the transport.
 *
 * @remarks
 * **Key responsibilities:**
 *
 * 1. **Connection management:**
 *    - Establishes connection to NATS servers on initialization
 *    - Provides reactive access to the connection via observables
 *    - Handles connection errors and reconnection events
 *    - Implements graceful shutdown with proper drain/close sequence
 *
 * 2. **JetStream integration:**
 *    - Creates and caches a JetStream manager instance
 *    - Provides reactive access to the manager via observable
 *    - Ensures manager is available before stream/consumer operations
 *
 * 3. **Status monitoring:**
 *    - Exposes connection status as an observable stream
 *    - Emits status events (connect, disconnect, reconnect, etc.)
 *    - Allows other components to react to connection state changes
 *
 * 4. **Resource cleanup:**
 *    - Implements OnModuleDestroy for proper lifecycle management
 *    - Ensures subscriptions are cleaned up on module destruction
 *    - Handles graceful shutdown on application termination
 *
 * **Observable caching:**
 *
 * The provider uses `shareReplay({ bufferSize: 1, refCount: false })` for connection
 * and JetStream manager observables. This ensures:
 * - Single connection instance shared across all subscribers
 * - New subscribers immediately receive the cached connection
 * - Connection persists even when all subscribers unsubscribe
 * - No duplicate connection attempts
 *
 * **Error handling:**
 *
 * Connection errors are categorized:
 * - `CONNECTION_REFUSED`: Terminal error, throws RuntimeException
 * - Other errors: Non-terminal, returns EMPTY to allow reconnection attempts
 *
 * @example
 * ```typescript
 * // Basic usage in a provider
 * class MyProvider {
 *   constructor(private connectionProvider: ConnectionProvider) {
 *     this.connectionProvider.nc.pipe(
 *       take(1),
 *       tap(connection => console.log('Connected to:', connection.nc))
 *     ).subscribe();
 *   }
 * }
 *
 * // Monitoring connection status
 * connectionProvider.status.subscribe(status => {
 *   console.log('Connection status:', status.type);
 * });
 *
 * // Graceful shutdown
 * connectionProvider.gracefulShutdown().subscribe(() => {
 *   console.log('Connection closed gracefully');
 * });
 * ```
 *
 * @see {@link https://docs.nats.io/using-nats/developer/connecting | NATS Connection Documentation}
 * @see {@link https://docs.nats.io/nats-concepts/jetstream | JetStream Documentation}
 */
@Injectable()
export class ConnectionProvider implements OnModuleDestroy {
  private readonly logger = new Logger(ConnectionProvider.name);

  /**
   * Observable that emits the NATS connection once established.
   * Cached and shared across all subscribers.
   *
   */
  private nc$!: Observable<NatsConnection>;

  /**
   * Observable that emits the JetStream manager once available.
   * Cached and shared across all subscribers.
   *
   */
  private jsm$!: Observable<JetStreamManager>;

  /**
   * Observable stream of connection status events.
   * Emits events like connect, disconnect, reconnect, error, etc.
   *
   */
  private status$!: Observable<Status>;

  /**
   * Raw unwrapped NATS connection instance.
   * Stored for direct access and graceful shutdown.
   *
   */
  private unwrappedConnection!: NatsConnection;

  /**
   * Optional subscription for internal cleanup.
   * Currently unused but available for future enhancements.
   *
   */
  private readonly subscription?: Subscription;

  /**
   * Creates a ConnectionProvider instance.
   *
   * @param options JetStream transport options including NATS connection configuration.
   *
   * @description
   * Initializes the connection setup immediately in the constructor.
   * The actual connection is established lazily when the nc$ observable is subscribed to.
   */
  public constructor(private readonly options: IJetstreamTransportOptions) {
    this.setupConnection();
  }

  /**
   * Observable stream of connection status events.
   *
   * @description
   * Provides access to the NATS connection status stream. Status events include:
   * - `connect`: Initial connection established
   * - `disconnect`: Connection lost
   * - `reconnect`: Connection re-established after disconnect
   * - `update`: Server discovery or cluster changes
   * - `error`: Connection errors.
   *
   * This stream does NOT replay previous events (uses `share()` instead of `shareReplay`),
   * so subscribers only receive events that occur after subscription.
   *
   * @returns Observable that emits connection status events.
   *
   * @example
   * ```typescript
   * connectionProvider.status.subscribe(status => {
   *   if (status.type === 'disconnect') {
   *     console.log('Connection lost, will attempt reconnect...');
   *   }
   * });
   * ```
   */
  public get status(): Observable<Status> {
    return this.status$;
  }

  /**
   * Observable that emits the NATS connection once established.
   *
   * @description
   * Provides reactive access to the NATS connection. The connection is:
   * - Established on first subscription (lazy)
   * - Cached and shared across all subsequent subscribers
   * - Persists even when all subscribers unsubscribe.
   *
   * Multiple subscriptions will share the same connection instance.
   *
   * @returns Observable that emits the NATS connection.
   *
   * @example
   * ```typescript
   * connectionProvider.nc.pipe(
   *   take(1),
   *   tap(nc => console.log('Server:', nc.getServer()))
   * ).subscribe();
   * ```
   */
  public get nc(): Observable<NatsConnection> {
    return this.nc$;
  }

  /**
   * Observable that emits the JetStream manager once available.
   *
   * @description
   * Provides reactive access to the JetStream manager instance.
   * The manager is created from the NATS connection and enables:
   * - Stream management (create, update, delete streams)
   * - Consumer management (create, update, delete consumers)
   * - Stream and consumer info queries.
   *
   * Like the connection, the manager is cached and shared.
   *
   * @returns Observable that emits the JetStream manager.
   *
   * @example
   * ```typescript
   * connectionProvider.jsm.pipe(
   *   take(1),
   *   switchMap(jsm => from(jsm.streams.list()))
   * ).subscribe(streams => console.log('Streams:', streams));
   * ```
   */
  public get jsm(): Observable<JetStreamManager> {
    return this.jsm$;
  }

  /**
   * Direct access to the unwrapped NATS connection.
   *
   * @description
   * Provides synchronous access to the raw NATS connection instance.
   * Use this when you need immediate access without subscribing to an observable.
   *
   * **Warning:** This getter assumes the connection has already been established.
   * If called before the connection is ready, it will return undefined.
   *
   * @returns The raw NATS connection instance.
   *
   * @example
   * ```typescript
   * const nc = connectionProvider.unwrap;
   * const serverUrl = nc.getServer();
   * ```
   */
  public get unwrap(): NatsConnection {
    return this.unwrappedConnection;
  }

  /**
   * Lifecycle hook called when the module is being destroyed.
   *
   * @description
   * Cleans up any active subscriptions to prevent memory leaks.
   * Currently, the subscription is optional and may not be used.
   */
  public onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /**
   * Gracefully shuts down the NATS connection.
   *
   * @description
   * Implements a proper shutdown sequence:
   *
   * 1. Checks if connection is already closed
   *    - If yes: returns immediately (no-op)
   *    - If no: proceeds with shutdown.
   *
   * 2. Drains the connection:
   *    - Stops accepting new messages
   *    - Waits for pending outbound messages to be sent
   *    - Waits for pending subscriptions to be flushed.
   *
   * 3. Waits for connection close:
   *    - Waits for the connection to fully close
   *    - Ensures all resources are released.
   *
   * 4. Error handling:
   *    - If drain fails: attempts force close
   *    - If close fails: swallows error and returns void.
   *
   * This ensures messages are not lost during shutdown and resources
   * are properly cleaned up.
   *
   * @returns Observable that completes when shutdown is finished or emits error if shutdown fails.
   *
   * @example
   * ```typescript
   * // In application shutdown hook
   * connectionProvider.gracefulShutdown().subscribe({
   *   next: () => console.log('Connection closed'),
   *   error: (err) => console.error('Shutdown error:', err),
   * });
   * ```
   */
  public gracefulShutdown(): Observable<void | Error | undefined> {
    return this.nc.pipe(
      take(1),
      switchMap((nc) =>
        iif(
          () => nc.isClosed(),
          of(void 0),
          from(nc.drain()).pipe(
            switchMap(() => from(nc.closed())),
            catchError(() => from(nc.close())),
            catchError(() => of(void 0)),
          ),
        ),
      ),
    );
  }

  /**
   * Sets up the NATS connection and related observables.
   *
   * @description
   * This method initializes three key observables:
   *
   * 1. **Connection observable (nc$):**
   *    - Creates connection to NATS servers using provided options
   *    - Adds service type suffix to connection name for identification
   *    - Handles connection errors via handleError()
   *    - Logs successful connection with server URL
   *    - Stores raw connection reference in unwrappedConnection
   *    - Uses shareReplay to cache and share connection.
   *
   * 2. **JetStream manager observable (jsm$):**
   *    - Derives from connection observable
   *    - Creates JetStream manager from connection
   *    - Logs manager initialization
   *    - Uses shareReplay to cache and share manager.
   *
   * 3. **Status observable (status$):**
   *    - Derives from connection observable
   *    - Maps connection to its status iterator
   *    - Converts async iterator to observable
   *    - Uses share() for event bus behavior (no replay).
   *
   * The setup is lazy - actual connection happens on first subscription.
   */
  protected setupConnection(): void {
    const name = `${this.options.name}_${this.options.serviceType}`;
    const connected$ = from(connect({ ...this.options, name } as ConnectionOptions));

    this.nc$ = connected$.pipe(
      catchError((err: NatsError) => this.handleError(err)),

      tap((connection) => {
        this.unwrappedConnection = connection;
        this.logger.log(`NATS connection established: ${connection.getServer()}`);
      }),

      shareReplay({ bufferSize: 1, refCount: false }),
    );

    this.jsm$ = this.nc$.pipe(
      switchMap((c: NatsConnection) => from(c.jetstreamManager())),

      tap(() => {
        this.logger.log('NATS JetStream manager initialized');
      }),

      shareReplay({ bufferSize: 1, refCount: false }),
    );

    this.status$ = this.nc$.pipe(
      switchMap((c: NatsConnection) => from(c.status())),
      share(), // event bus; no replay
    );
  }

  /**
   * Handles connection errors with appropriate error strategies.
   *
   * @description
   * Implements error categorization:
   *
   * - **CONNECTION_REFUSED:**
   *   This is a terminal error indicating NATS servers are unreachable.
   *   Throws RuntimeException to fail fast and prevent the application
   *   from starting in an inconsistent state.
   *
   * - **Other errors:**
   *   Non-terminal errors that may be transient (network issues, etc.).
   *   Returns EMPTY to complete the observable without emitting.
   *   This allows retry logic at higher levels to attempt reconnection.
   *
   * @param err The NATS error to handle.
   * @returns Observable that either throws or completes empty.
   *
   * @throws {RuntimeException} When connection is refused (servers unreachable).
   */
  protected handleError(err: NatsError): Observable<NatsConnection> {
    if (err.code === 'CONNECTION_REFUSED') throw new RuntimeException(err.message);

    return EMPTY;
  }
}
