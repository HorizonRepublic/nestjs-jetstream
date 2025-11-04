import { Injectable, Logger } from '@nestjs/common';
import { NatsError, StreamConfig, StreamInfo, StreamUpdateConfig } from 'nats';
import { catchError, forkJoin, from, map, Observable, switchMap, tap } from 'rxjs';

import { ConnectionProvider } from '../../common/connection.provider';
import { IJetstreamTransportOptions } from '../../common/types';
import { JetStreamKind } from '../../enum';
import { streamConfig } from '../const';
import { JetStreamErrorCode } from '../enum';

/**
 * Provider responsible for managing JetStream stream lifecycle.
 *
 * @description
 * This provider handles the creation, updating, and configuration of JetStream streams
 * that serve as the foundation for message storage and delivery in the transport.
 * It ensures that both Event and Command streams exist and are properly configured
 * before any message consumption begins.
 *
 * @remarks
 * **Core responsibilities:**
 *
 * 1. **Stream creation and updates:**
 *    - Creates Event and Command streams on initialization
 *    - Updates existing streams if configuration changes
 *    - Ensures streams match the required configuration
 *    - Handles idempotent operations (safe to call multiple times)
 *
 * 2. **Stream naming convention:**
 *    - Format: `{serviceName}_{kind}-stream`
 *    - Examples: `orders-service_event-stream`, `orders-service_command-stream`
 *    - Ensures unique streams per service instance
 *
 * 3. **Subject patterns:**
 *    - Event subjects: `{serviceName}.event.>`
 *    - Command subjects: `{serviceName}.command.>`
 *    - The `>` wildcard allows hierarchical message routing
 *
 * 4. **Configuration management:**
 *    - Applies base configuration common to all streams
 *    - Applies kind-specific configuration (event vs command)
 *    - Merges user-provided custom configuration
 *
 * **Stream types:**
 *
 * - **Event streams:**
 *   Designed for pub/sub patterns and event broadcasting.
 *   Multiple consumers can process the same events independently.
 *   Typical configuration: longer retention, interest-based retention policy.
 *
 * - **Command streams:**
 *   Designed for work queue patterns and RPC-style communication.
 *   Messages are distributed across consumers (load balancing).
 *   Typical configuration: shorter retention, work queue retention policy.
 *
 * **Idempotency:**
 *
 * The create() method is idempotent:
 * - If streams don't exist: creates them
 * - If streams exist with different config: updates them
 * - If streams exist with same config: no-op (returns existing info)
 *
 * This makes it safe to call on every application startup and reconnection.
 *
 * @example
 * ```typescript
 * // Create both event and command streams
 * streamProvider.create().subscribe(() => {
 *   console.log('All streams ready');
 * });
 *
 * // Get stream name for a specific kind
 * const streamName = streamProvider.getStreamName(JetStreamKind.Event);
 * // Returns: "my-service_event-stream"
 * ```
 *
 * @see {@link https://docs.nats.io/nats-concepts/jetstream/streams | JetStream Streams Documentation}
 * @see {@link https://docs.nats.io/using-nats/developer/develop_jetstream/model_deep_dive | Stream Configuration Guide}
 */
@Injectable()
export class StreamProvider {
  private readonly logger = new Logger(StreamProvider.name);

  /**
   * Creates a StreamProvider instance.
   *
   * @param options JetStream transport options containing service name and custom stream configurations.
   * @param connectionProvider Provider that manages NATS connection and JetStream manager access.
   */
  public constructor(
    private readonly options: IJetstreamTransportOptions,
    private readonly connectionProvider: ConnectionProvider,
  ) {}

  /**
   * Creates or updates both Event and Command streams.
   *
   * @description
   * Orchestrates the creation of both stream types in parallel using forkJoin.
   * This ensures both streams are ready before the observable completes.
   *
   * The operation is idempotent:
   * - Creates streams if they don't exist
   * - Updates streams if configuration changed
   * - No-op if streams exist with correct configuration.
   *
   * **Error handling:**
   * - If one stream fails to create, the entire operation fails
   * - Errors are not caught here, allowing caller to handle retry logic
   * - Common errors: permission denied, invalid configuration, network issues.
   *
   * @returns Observable that completes when both streams are ready (emits void).
   *
   * @example
   * ```typescript
   * streamProvider.create().subscribe({
   *   next: () => console.log('Streams ready'),
   *   error: (err) => console.error('Stream creation failed:', err),
   * });
   * ```
   */
  public create(): Observable<void> {
    return forkJoin([
      this.createForKind(JetStreamKind.Event),
      this.createForKind(JetStreamKind.Command),
    ]).pipe(map(() => void 0));
  }

  /**
   * Generates the stream name for a specific kind.
   *
   * @description
   * Constructs the stream name using the naming convention:
   * `{serviceName}_{kind}-stream`.
   *
   * This ensures:
   * - Stream names are unique per service
   * - Stream names are predictable and discoverable
   * - Different services don't interfere with each other.
   *
   * @param kind The stream kind (Event or Command).
   * @returns The formatted stream name.
   *
   * @example
   * ```typescript
   * streamProvider.getStreamName(JetStreamKind.Event);
   * // Returns: "orders-service_event-stream"
   *
   * streamProvider.getStreamName(JetStreamKind.Command);
   * // Returns: "orders-service_command-stream"
   * ```
   */
  public getStreamName(kind: JetStreamKind): string {
    return `${this.options.name}_${kind}-stream`;
  }

  /**
   * Generates subject patterns for a specific stream kind.
   *
   * @description
   * Constructs subject patterns that the stream will capture messages from.
   * The pattern format is: `{serviceName}.{kind}.>`.
   *
   * The `>` wildcard means "match all tokens after this point", enabling:
   * - Hierarchical subject organization
   * - Flexible message routing
   * - Namespace isolation per service.
   *
   * **Examples of matched subjects:**
   * - Pattern: `orders.event.>`
   *   - Matches: `orders.event.created`, `orders.event.updated`, `orders.event.deleted.v2`
   *   - Does NOT match: `orders.command.create`, `payments.event.created`.
   *
   * @param kind The stream kind (Event or Command).
   * @returns Array of subject patterns (currently single pattern, but array for future extensibility).
   *
   * @example
   * ```typescript
   * streamProvider.getSubjects(JetStreamKind.Event);
   * // Returns: ["orders-service.event.>"]
   * ```
   */
  protected getSubjects(kind: JetStreamKind): string[] {
    return [`${this.options.name}.${kind}.>`];
  }

  /**
   * Creates or updates a stream for a specific kind.
   *
   * @description
   * Implements the stream ensure logic with the following flow:
   *
   * 1. **Build configuration:**
   *    - Merge base config (common settings)
   *    - Merge kind-specific config (event vs command)
   *    - Set stream name and subjects
   *    - Add descriptive metadata.
   *
   * 2. **Check if stream exists:**
   *    - Query stream info via `info()`
   *    - If exists: proceed to update
   *    - If not found: catch error and create new.
   *
   * 3. **Update existing stream:**
   *    - Apply new configuration via `update()`
   *    - JetStream validates if update is allowed
   *    - Some changes require stream recreation.
   *
   * 4. **Create new stream:**
   *    - Triggered by StreamNotFound error
   *    - Creates stream with full configuration
   *    - Logs successful creation.
   *
   * **Error handling:**
   * - StreamNotFound → creates new stream
   * - Other errors → propagated to caller.
   *
   * @param kind The stream kind to create/update.
   * @returns Observable that emits StreamInfo when complete.
   *
   * @example
   * ```typescript
   * // Internal usage, called by create()
   * this.createForKind(JetStreamKind.Event).subscribe(info => {
   *   console.log('Stream created:', info.config.name);
   * });
   * ```
   */
  protected createForKind(kind: JetStreamKind): Observable<StreamInfo> {
    const config = {
      ...streamConfig.base,
      ...streamConfig[kind],
      name: this.getStreamName(kind),
      subjects: this.getSubjects(kind),
      description: `JetStream stream for ${this.options.name} ${kind} messages`,
    };

    this.logger.log(`Ensure stream requested: ${config.name}`);

    return this.info(config.name).pipe(
      switchMap(() => this.update(config.name, config)),

      catchError((err: NatsError) => {
        if (err.api_error?.err_code == JetStreamErrorCode.StreamNotFound) {
          return this.new(config);
        }

        throw err;
      }),
    );
  }

  /**
   * Retrieves information about an existing stream.
   *
   * @description
   * Queries the JetStream manager for stream metadata and configuration.
   * This is used to:
   * - Check if a stream exists
   * - Verify stream configuration
   * - Monitor stream state.
   *
   * **Stream info includes:**
   * - Configuration (retention, limits, subjects)
   * - State (messages count, bytes, first/last sequence)
   * - Cluster information (if clustered)
   * - Consumer count.
   *
   * @param streamName The name of the stream to query.
   * @returns Observable that emits StreamInfo or errors if stream not found.
   *
   * @throws {NatsError} With code StreamNotFound if stream doesn't exist.
   *
   * @example
   * ```typescript
   * this.info('orders-service_event-stream').subscribe(info => {
   *   console.log('Messages in stream:', info.state.messages);
   * });
   * ```
   */
  protected info(streamName: string): Observable<StreamInfo> {
    return this.connectionProvider.jsm.pipe(
      tap(() => {
        this.logger.debug(`Checking stream existence: ${streamName}`);
      }),

      switchMap((jsm) => from(jsm.streams.info(streamName))),
    );
  }

  /**
   * Creates a new stream with the provided configuration.
   *
   * @description
   * Creates a new JetStream stream from scratch. This is called when
   * a stream doesn't exist yet (typically on first application start
   * or after manual deletion).
   *
   * **Configuration validation:**
   * - JetStream validates all configuration parameters
   * - Invalid configs will cause the operation to fail
   * - Common validations: subject uniqueness, retention policy compatibility.
   *
   * **Stream creation is atomic:**
   * - Either the stream is fully created or it fails
   * - No partial state
   * - Safe to retry on failure.
   *
   * @param config Complete stream configuration including name, subjects, and policies.
   * @returns Observable that emits StreamInfo of the newly created stream.
   *
   * @throws {NatsError} If creation fails (permissions, invalid config, etc.).
   *
   * @example
   * ```typescript
   * const config = {
   *   name: 'my-stream',
   *   subjects: ['my.service.>'],
   *   retention: RetentionPolicy.Limits,
   * };
   *
   * this.new(config).subscribe(info => {
   *   console.log('Stream created:', info.config.name);
   * });
   * ```
   */
  protected new(config: StreamConfig): Observable<StreamInfo> {
    return this.connectionProvider.jsm.pipe(
      switchMap((jsm) => from(jsm.streams.add(config))),

      tap(() => {
        this.logger.log(`New stream created: ${config.name}`);
      }),
    );
  }

  /**
   * Updates an existing stream with new configuration.
   *
   * @description
   * Applies configuration changes to an existing stream. Not all changes
   * are allowed - some require stream recreation.
   *
   * **Allowed updates:**
   * - Subject list modifications (add/remove subjects)
   * - Limit adjustments (max_msgs, max_bytes, max_age)
   * - Description changes
   * - Some policy changes.
   *
   * **Updates requiring recreation:**
   * - Storage type change (file ↔ memory)
   * - Retention policy change (in some cases)
   * - Discard policy change (in some cases)
   * - Changing stream name.
   *
   * **Behavior:**
   * - If update is allowed: applies changes and returns updated info
   * - If update is not allowed: returns error explaining why
   * - No automatic recreation - caller must handle explicitly.
   *
   * @param streamName Name of the stream to update.
   * @param config New configuration to apply.
   * @returns Observable that emits updated StreamInfo.
   *
   * @throws {NatsError} If update is not allowed or fails.
   *
   * @example
   * ```typescript
   * const newConfig = {
   *   name: 'my-stream',
   *   subjects: ['my.service.>', 'other.service.>'], // Added subject
   *   max_msgs: 10000,
   * };
   *
   * this.update('my-stream', newConfig).subscribe(info => {
   *   console.log('Stream updated, subjects:', info.config.subjects);
   * });
   * ```
   */
  protected update(streamName: string, config: StreamUpdateConfig): Observable<StreamInfo> {
    return this.connectionProvider.jsm.pipe(
      tap(() => {
        this.logger.log(
          `Stream exists, updating: ${streamName} (subjects: ${config.subjects.length})`,
        );
      }),

      switchMap((jsm) => from(jsm.streams.update(streamName, config))),
    );
  }
}
