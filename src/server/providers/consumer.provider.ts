import { Injectable, Logger } from '@nestjs/common';
import { ConsumerInfo, NatsError } from 'nats';
import { catchError, forkJoin, from, map, Observable, Subject, switchMap, tap } from 'rxjs';

import { ConnectionProvider } from '../../common/connection.provider';
import { IJetstreamTransportOptions } from '../../common/types';
import { JetStreamKind } from '../../enum';
import { consumerConfig } from '../const';
import { JetStreamErrorCode } from '../enum';

import { StreamProvider } from './stream.provider';

/**
 * Provider responsible for managing JetStream consumer lifecycle.
 *
 * @description
 * This provider handles the creation and configuration of JetStream consumers
 * that pull messages from streams for processing. It ensures that durable consumers
 * exist for both Event and Command streams before message consumption begins.
 *
 * @remarks
 * **Core responsibilities:**
 *
 * 1. **Consumer creation:**
 *    - Creates durable consumers for Event and Command streams
 *    - Configures consumers with appropriate delivery semantics
 *    - Ensures consumers survive server restarts (durable)
 *    - Handles idempotent creation (safe to call multiple times)
 *
 * 2. **Consumer naming:**
 *    - Format: `{serviceName}_{kind}-consumer`
 *    - Examples: `orders-service_event-consumer`, `orders-service_command-consumer`
 *    - Ensures unique consumers per service instance
 *
 * 3. **Consumer tracking:**
 *    - Maintains a map of created consumers
 *    - Exposes consumer info via observable stream
 *    - Allows downstream components to access consumer metadata
 *
 * 4. **Configuration management:**
 *    - Applies kind-specific consumer configuration
 *    - Merges user-provided custom configuration
 *    - Sets appropriate delivery policies (pull-based)
 *
 * **Consumer types:**
 *
 * - **Event consumers:**
 *   Configured for fan-out patterns where multiple services process the same events.
 *   Typically use:
 *   - Pull-based delivery for backpressure control
 *   - Durable storage to survive restarts
 *   - Individual acknowledgment mode
 *
 * - **Command consumers:**
 *   Configured for work queue patterns where commands are distributed across instances.
 *   Typically use:
 *   - Pull-based delivery with batch fetching
 *   - Explicit acknowledgment for at-least-once delivery
 *   - Queue group semantics (multiple instances share work)
 *
 * **Durable consumers:**
 *
 * All consumers created by this provider are durable, meaning:
 * - Consumer state persists across restarts
 * - Message position is tracked in JetStream
 * - Unacknowledged messages are redelivered
 * - Consumer can resume from last processed message
 *
 * **Idempotency:**
 *
 * The create() method is idempotent:
 * - If consumers don't exist: creates them
 * - If consumers exist: returns existing info
 * - Safe to call on every reconnection
 *
 * @example
 * ```typescript
 * // Create both event and command consumers
 * consumerProvider.create().subscribe(() => {
 *   console.log('All consumers ready');
 * });
 *
 * // Access consumer info
 * consumerProvider.consumerMap$.subscribe(map => {
 *   const eventConsumer = map.get(JetStreamKind.Event);
 *   console.log('Event consumer:', eventConsumer?.name);
 * });
 * ```
 *
 * @see {@link https://docs.nats.io/nats-concepts/jetstream/consumers | JetStream Consumers Documentation}
 * @see {@link https://docs.nats.io/using-nats/developer/develop_jetstream/consumers | Consumer Configuration Guide}
 */
@Injectable()
export class ConsumerProvider {
  private readonly logger = new Logger(ConsumerProvider.name);

  /**
   * Subject that emits a map of created consumers.
   *
   * @description
   * This subject is used to notify downstream components when consumers
   * are created or updated. The map keys are JetStreamKind values (Event/Command),
   * and values are ConsumerInfo objects containing consumer metadata.
   */
  private readonly consumers$ = new Subject<Map<JetStreamKind, ConsumerInfo>>();

  /**
   * Creates a ConsumerProvider instance.
   *
   * @param options JetStream transport options containing service name and custom consumer configurations.
   * @param connectionProvider Provider that manages NATS connection and JetStream manager access.
   * @param streamProvider Provider that manages stream lifecycle and provides stream names.
   */
  public constructor(
    private readonly options: IJetstreamTransportOptions,
    private readonly connectionProvider: ConnectionProvider,
    private readonly streamProvider: StreamProvider,
  ) {}

  /**
   * Observable stream of consumer information maps.
   *
   * @description
   * Provides reactive access to the map of created consumers. This observable:
   * - Emits when consumers are created or updated
   * - Contains metadata for both Event and Command consumers
   * - Allows downstream components to access consumer info without direct queries.
   *
   * **Consumer info includes:**
   * - Consumer name and configuration
   * - Delivery statistics (pending, redelivered messages)
   * - Acknowledgment state
   * - Stream association.
   *
   * @returns Observable that emits consumer info maps.
   *
   * @example
   * ```typescript
   * consumerProvider.consumerMap$.subscribe(map => {
   *   const eventConsumer = map.get(JetStreamKind.Event);
   *   console.log('Event consumer pending:', eventConsumer?.num_pending);
   *
   *   const commandConsumer = map.get(JetStreamKind.Command);
   *   console.log('Command consumer name:', commandConsumer?.name);
   * });
   * ```
   */
  public get consumerMap$(): Observable<Map<JetStreamKind, ConsumerInfo>> {
    return this.consumers$.asObservable();
  }

  /**
   * Creates or retrieves both Event and Command consumers.
   *
   * @description
   * Orchestrates the creation of both consumer types in parallel using forkJoin.
   * This ensures both consumers are ready before the observable completes.
   *
   * The operation is idempotent:
   * - Creates consumers if they don't exist
   * - Returns existing consumers if they already exist
   * - No-op if consumers are already configured correctly.
   *
   * **Flow:**
   * 1. Create Event consumer (or retrieve existing)
   * 2. Create Command consumer (or retrieve existing)
   * 3. Build a map with both consumer infos
   * 4. Emit map to consumers$ subject for downstream access
   * 5. Return void to indicate completion.
   *
   * **Error handling:**
   * - If one consumer fails to create, the entire operation fails
   * - Errors are not caught here, allowing caller to handle retry logic
   * - Common errors: stream not found, permission denied, invalid configuration.
   *
   * @returns Observable that completes when both consumers are ready (emits void).
   *
   * @example
   * ```typescript
   * consumerProvider.create().subscribe({
   *   next: () => console.log('Consumers ready'),
   *   error: (err) => console.error('Consumer creation failed:', err),
   * });
   * ```
   */
  public create(): Observable<void> {
    return forkJoin({
      command: this.createForKind(JetStreamKind.Command),
      event: this.createForKind(JetStreamKind.Event),
    }).pipe(
      tap((results) => {
        const map = new Map<JetStreamKind, ConsumerInfo>([
          [JetStreamKind.Command, results.command],
          [JetStreamKind.Event, results.event],
        ]);

        this.consumers$.next(map);
      }),

      map(() => void 0),
    );
  }

  /**
   * Creates or retrieves a consumer for a specific kind.
   *
   * @description
   * Implements the consumer ensure logic with the following flow:
   *
   * 1. **Get stream name:**
   *    - Retrieves the associated stream name from StreamProvider
   *    - Ensures consumer is created for the correct stream.
   *
   * 2. **Build consumer configuration:**
   *    - Uses predefined config from consumerConfig constant
   *    - Applies service name and kind to configuration
   *    - Sets durable name for persistence.
   *
   * 3. **Check if consumer exists:**
   *    - Query consumer info via JetStream manager
   *    - If exists: logs and returns existing info
   *    - If not found: catches error and proceeds to creation.
   *
   * 4. **Create new consumer:**
   *    - Triggered by ConsumerNotFound error
   *    - Creates durable consumer with full configuration
   *    - Logs successful creation.
   *
   * **Consumer configuration includes:**
   * - Durable name (for persistence)
   * - Delivery policy (all, last, new, by_start_sequence, by_start_time)
   * - Ack policy (explicit, all, none)
   * - Ack wait time (how long to wait for acknowledgment)
   * - Max deliver attempts (redelivery limit)
   * - Filter subjects (optional subject filtering).
   *
   * **Error handling:**
   * - ConsumerNotFound → creates new consumer
   * - Other errors → propagated to caller.
   *
   * @param kind The consumer kind to create/retrieve (Event or Command).
   * @returns Observable that emits ConsumerInfo when complete.
   *
   * @throws {NatsError} If creation fails (stream not found, permissions, invalid config).
   *
   * @example
   * ```typescript
   * // Internal usage, called by create()
   * this.createForKind(JetStreamKind.Event).subscribe(info => {
   *   console.log('Consumer created:', info.name);
   *   console.log('Pending messages:', info.num_pending);
   * });
   * ```
   */
  protected createForKind(kind: JetStreamKind): Observable<ConsumerInfo> {
    const streamName = this.streamProvider.getStreamName(kind);
    const config = consumerConfig[kind](this.options.name, kind);

    return this.connectionProvider.jsm.pipe(
      switchMap((jsm) =>
        from(jsm.consumers.info(streamName, config.durable_name ?? '')).pipe(
          tap(() => {
            this.logger.debug(`Consumer exists: ${config.durable_name}`);
          }),

          catchError((err: NatsError) => {
            if (err.api_error?.err_code === JetStreamErrorCode.ConsumerNotFound) {
              this.logger.debug(`Creating consumer: ${config.durable_name}`);

              return from(jsm.consumers.add(streamName, config));
            }

            throw err;
          }),
        ),
      ),
    );
  }
}
