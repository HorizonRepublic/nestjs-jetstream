import { Injectable, OnModuleInit } from '@nestjs/common';
import { CustomTransportStrategy, Server, TransportId } from '@nestjs/microservices';
import { Events, NatsConnection } from 'nats';
import { filter, startWith, Subject, switchMap, takeUntil, tap } from 'rxjs';

import { ConnectionProvider } from '../common/connection.provider';

import { ConsumerProvider } from './providers/consumer.provider';
import { StreamProvider } from './providers/stream.provider';
import { INatsEventsMap } from './types/nats.events-map';

/**
 * Custom transport strategy for NATS JetStream integration with NestJS microservices.
 *
 * @description
 * This class implements a custom transport strategy that enables NestJS microservices
 * to communicate via NATS JetStream. It handles the complete lifecycle of the transport,
 * including connection management, stream creation, consumer setup, and automatic reconnection.
 *
 * The strategy extends the NestJS `Server` class and implements both `CustomTransportStrategy`
 * and `OnModuleInit` interfaces to integrate seamlessly with the NestJS lifecycle.
 *
 * @remarks
 * Key features:
 * - Automatic reconnection handling on connection loss
 * - Stream and consumer lifecycle management
 * - Event-driven architecture using RxJS
 * - Graceful shutdown support
 * - Type-safe event handling via NATS events map
 *
 *
 * @see {@link https://docs.nestjs.com/microservices/custom-transport | NestJS Custom Transport}
 * @see {@link https://docs.nats.io/nats-concepts/jetstream | NATS JetStream Documentation}
 */
@Injectable()
export class JetstreamStrategy
  extends Server<INatsEventsMap>
  implements CustomTransportStrategy, OnModuleInit
{
  /**
   * Unique identifier for this transport strategy.
   *
   * @description
   * A symbol that uniquely identifies this transport within the NestJS microservices ecosystem.
   * This ensures that the transport can be distinguished from other custom transports.
   */
  public override readonly transportId: TransportId = Symbol('jetstream-transport');

  /**
   * Subject for managing component lifecycle and cleanup.
   *
   * @description
   * Emits when the transport is being destroyed, signaling all active subscriptions
   * to complete and clean up their resources.
   */
  private readonly destroy$ = new Subject<void>();

  /**
   * Subject for triggering reconnection logic.
   *
   * @description
   * Emits when the NATS connection is re-established, triggering the recreation
   * of streams and consumers to resume normal operation.
   */
  private readonly reconnect$ = new Subject<void>();

  /**
   * Creates an instance of JetstreamStrategy.
   *
   * @param connectionProvider Provider that manages the NATS connection lifecycle and status.
   * @param streamProvider Provider responsible for creating and managing JetStream streams.
   * @param consumerProvider Provider responsible for creating and managing JetStream consumers.
   */
  public constructor(
    private readonly connectionProvider: ConnectionProvider,
    private readonly streamProvider: StreamProvider,
    private readonly consumerProvider: ConsumerProvider,
  ) {
    super();
  }

  /**
   * Lifecycle hook that runs after module initialization.
   *
   * @description
   * Sets up automatic reconnection handling by listening to NATS reconnect events.
   * When a reconnection occurs, it triggers the `reconnect$` subject to reinitialize
   * streams and consumers.
   *
   * This ensures that the transport can automatically recover from connection failures
   * without manual intervention.
   */
  public onModuleInit(): void {
    this.on(Events.Reconnect, () => {
      this.reconnect$.next();
    });
  }

  /**
   * Starts listening for messages on the JetStream transport.
   *
   * @description
   * Initializes the transport by:
   * 1. Setting up a reactive pipeline that responds to reconnection events
   * 2. Creating necessary JetStream streams via `StreamProvider`
   * 3. Creating JetStream consumers via `ConsumerProvider`
   * 4. Invoking the callback when setup is complete.
   *
   * The pipeline automatically handles reconnections by recreating streams and consumers
   * when the `reconnect$` subject emits. The `startWith` operator ensures the pipeline
   * runs immediately on first subscription.
   *
   * @param done Callback function invoked after successful initialization or reconnection.
   */
  public listen(done: () => void): void {
    this.reconnect$
      .pipe(
        startWith(void 0),
        switchMap(() => this.streamProvider.create()),
        switchMap(() => this.consumerProvider.create()),
        tap(done),
        takeUntil(this.destroy$),
      )
      .subscribe();
  }

  /**
   * Closes the transport and cleans up all resources.
   *
   * @description
   * Performs graceful shutdown by:
   * 1. Emitting to `destroy$` to complete all active subscriptions
   * 2. Completing the destroy subject itself
   * 3. Initiating graceful shutdown of the NATS connection.
   *
   * This ensures that all messages are processed and acknowledged before
   * the connection is terminated.
   */
  public close(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.connectionProvider.gracefulShutdown().subscribe();
  }

  /**
   * Registers an event listener for NATS connection events.
   *
   * @description
   * Sets up a type-safe event listener that subscribes to connection status changes
   * from the `ConnectionProvider`. When an event matching the specified type occurs,
   * the callback is invoked with the event data.
   *
   * The subscription is automatically cleaned up when the transport is destroyed.
   *
   * @template EventKey - Type of event key from the NATS events map.
   * @param event The NATS event to listen for (e.g., `Events.Reconnect`, `Events.Disconnect`).
   * @param callback Callback function invoked when the event occurs, receives event data as argument.
   *
   * @example
   * ```typescript
   * strategy.on(Events.Disconnect, () => {
   *   console.log('Connection lost');
   * });
   * ```
   */
  public on<EventKey extends keyof INatsEventsMap>(
    event: EventKey,
    callback: INatsEventsMap[EventKey],
  ): void {
    this.connectionProvider.status
      .pipe(
        filter((status) => status.type == event),
        tap((status) => {
          const args = [status.data];

          (callback as (...args: unknown[]) => void)(...args);
        }),
        takeUntil(this.destroy$),
      )
      .subscribe();
  }

  /**
   * Retrieves the underlying NATS connection instance.
   *
   * @description
   * Provides direct access to the raw NATS connection for advanced use cases
   * where low-level NATS API access is required. This is useful for custom
   * operations not covered by the transport abstraction.
   *
   * @template T - Type to cast the connection to, defaults to `NatsConnection`.
   * @returns The unwrapped NATS connection instance.
   *
   * @example
   * ```typescript
   * const connection = strategy.unwrap<NatsConnection>();
   * const jsm = await connection.jetstreamManager();
   * ```
   */
  public override unwrap<T = NatsConnection>(): T {
    return this.connectionProvider.unwrap as T;
  }
}
