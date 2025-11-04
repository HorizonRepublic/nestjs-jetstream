import { Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy, ReadPacket, WritePacket } from '@nestjs/microservices';
import { createInbox, headers, JSONCodec, Msg, MsgHdrs, NatsConnection, PubAck } from 'nats';
import { firstValueFrom, Subject, takeUntil, tap } from 'rxjs';
import { v7 } from 'uuid';

import { JetstreamHeaders, JetStreamKind } from '../enum';

import { IClientProviders } from './types';

/**
 * NATS JetStream client proxy for NestJS microservices.
 *
 * Implements hybrid messaging pattern:
 * - Events: Fire-and-forget via JetStream (guaranteed delivery, no response)
 * - Commands: Request-reply via JetStream + Core NATS inbox (RPC with response).
 *
 * Architecture:.
 * ```
 * Events:   Client --[JetStream publish]--> Stream --> Consumers
 *           └─> returns immediately
 *
 * Commands: Client --[JetStream publish]--> Stream --> Consumer
 *           └─[inbox subscribe]<--[Core NATS publish]<-- Response
 *           └─> waits for response via callback
 * ```
 *
 * @example
 * ```typescript
 * // Fire-and-forget event
 * await firstValueFrom(client.emit('user.created', { id: 1 }));
 *
 * // Request-reply command
 * const user = await firstValueFrom(client.send('get.user', { id: 1 }));
 * ```
 */
export class JetstreamClientProxy extends ClientProxy implements OnModuleInit {
  private readonly logger = new Logger(JetstreamClientProxy.name);
  private readonly destroy$ = new Subject<void>();

  /**
   * Unique inbox subject for receiving RPC responses.
   * Format: <service_name>.<random>
   * Shared across all command requests from this client instance.
   */
  private readonly inbox = createInbox(this.providers.options.name);

  // todo: make configurable
  private readonly codec = JSONCodec();

  /**
   * Map of pending RPC requests awaiting responses.
   * Key: correlation ID (UUID v7)
   * Value: callback to invoke when response arrives.
   */
  private readonly pendingMessages = new Map<string, (p: WritePacket) => void>();

  /**
   * Flag to prevent duplicate inbox subscriptions.
   * Reset to false on connection errors to allow re-subscription.
   */
  private isInboxSubscribed = false;

  public constructor(private readonly providers: IClientProviders) {
    super();
    this.logger.debug(`JetStream client initialized (inbox: ${this.inbox})`);
  }

  /**
   * Establish connection and setup inbox on module initialization to don't wait for the first request.
   */
  public onModuleInit(): void {
    void this.connect();
  }

  /**
   * Establishes NATS connection and sets up an inbox subscription for RPC responses.
   *
   * Idempotent: multiple calls reuse existing connection and subscription.
   * Automatically recovers subscription after reconnection.
   *
   * @returns Promise resolving to active NATS connection.
   */
  public async connect(): Promise<NatsConnection> {
    const nc = await firstValueFrom(this.providers.connectionProvider.nc);

    if (!this.isInboxSubscribed) {
      this.isInboxSubscribed = true;

      this.providers.connectionProvider.nc
        .pipe(
          tap((connection) => {
            if (!connection.isClosed() && !connection.isDraining()) {
              this.setupInboxSubscription(connection);
            }
          }),
          takeUntil(this.destroy$),
        )
        .subscribe({
          error: (err) => {
            this.logger.error('Connection stream error, will retry on next connect()', err);
            this.isInboxSubscribed = false;
          },
        });
    }

    return nc;
  }

  /**
   * Gracefully closes connection and cleans up resources.
   *
   * Emits destroy signal to stop connection monitoring,
   * completes all pending observables, and closes NATS connection.
   */
  public async close(): Promise<void> {
    this.logger.debug('Closing client and cleaning up resources');

    this.destroy$.next();
    this.destroy$.complete();

    const nc = await firstValueFrom(this.providers.connectionProvider.nc);

    await nc.close();
  }

  /**
   * Returns raw NATS connection for advanced use cases.
   *
   * @returns Raw NATS connection instance.
   */
  public override unwrap<T = NatsConnection>(): T {
    return this.providers.connectionProvider.unwrap as T;
  }

  /**
   * Publishes fire-and-forget event to JetStream.
   *
   * Does not wait for acknowledgment or response.
   * JetStream guarantees persistence and at-least-once delivery to consumers.
   *
   * @param packet Event packet containing pattern and data.
   * @returns Promise resolving immediately after publish (undefined).
   */
  protected async dispatchEvent<T = PubAck>(packet: ReadPacket<T>): Promise<T> {
    const subject = this.buildSubject(JetStreamKind.Event, packet.pattern);
    const messageId = v7();

    this.logger.verbose(`Event details: ${subject} (id: ${messageId})`);

    const nc = await this.connect();
    const hdrs = this.createHeaders({ messageId, subject });

    // Fire-and-forget: don't await acknowledgment
    void nc.jetstream().publish(subject, this.codec.encode(packet.data), { headers: hdrs });

    return undefined as T;
  }

  /**
   * Publishes RPC command to JetStream and registers callback for response.
   *
   * Command is persisted in JetStream for guaranteed delivery.
   * Response arrives via Core NATS inbox subscription.
   *
   * Pattern:
   * 1. Register callback in pending map with correlation ID
   * 2. Publish command with reply-to inbox address
   * 3. Consumer processes command and publishes response to inbox
   * 4. Inbox subscription routes response to callback via correlation ID.
   *
   * @param packet Command packet containing pattern and data.
   * @param callback Function to invoke when response arrives or error occurs.
   * @returns Cleanup function to cancel pending request.
   */
  protected publish(packet: ReadPacket, callback: (p: WritePacket) => void): () => void {
    const subject = this.buildSubject(JetStreamKind.Command, packet.pattern);
    const correlationId = v7();
    const messageId = v7();

    this.pendingMessages.set(correlationId, callback);

    this.logger.verbose(`Command details: ${subject} (id: ${messageId}, cid: ${correlationId})`);

    void this.publishCommand(subject, packet.data, { correlationId, messageId, callback });

    return () => {
      this.logger.verbose(`Cleanup requested for correlation ID: ${correlationId}`);
      this.pendingMessages.delete(correlationId);
    };
  }

  /**
   * Internal: executes command publication with error handling.
   *
   * Invokes callback immediately on publish error to fail fast.
   * On success, response will arrive asynchronously via inbox.
   *
   * @param subject Fully-qualified NATS subject to publish to.
   * @param data Payload data to encode and send.
   * @param ctx Context object containing correlation metadata.
   * @param ctx.correlationId UUID v7 linking request and response.
   * @param ctx.messageId Unique message identifier for tracing.
   * @param ctx.callback Function to invoke on error or when response arrives.
   */
  private async publishCommand(
    subject: string,
    data: unknown,
    ctx: { correlationId: string; messageId: string; callback(p: WritePacket): void },
  ): Promise<void> {
    try {
      const nc = await this.connect();

      const hdrs = this.createHeaders({
        correlationId: ctx.correlationId,
        messageId: ctx.messageId,
        subject,
        replyTo: this.inbox,
      });

      await nc.jetstream().publish(subject, this.codec.encode(data), { headers: hdrs });

      this.logger.verbose(`Command successfully published: ${subject} (cid: ${ctx.correlationId})`);
    } catch (error) {
      this.logger.error(`Command publish failed: ${subject}`, error);

      // Fail fast: invoke callback with error
      ctx.callback({
        err: error instanceof Error ? error.message : 'Unknown error',
        response: null,
      });

      this.pendingMessages.delete(ctx.correlationId);
    }
  }

  /**
   * Sets up Core NATS subscription to inbox for receiving RPC responses.
   *
   * Inbox subscription persists across multiple command requests.
   * Each response is routed to the correct callback via correlation ID.
   *
   * Note: Uses Core NATS (not JetStream) for low-latency, ephemeral replies.
   *
   * @param nc Active NATS connection to subscribe with.
   */
  private setupInboxSubscription(nc: NatsConnection): void {
    this.logger.log(`Inbox subscription established: ${this.inbox}`);

    nc.subscribe(this.inbox, {
      callback: (error, msg) => {
        if (error) {
          this.logger.error('Inbox subscription error:', error);
          return;
        }

        this.logger.verbose('← Response received in inbox');
        this.routeReply(msg);
      },
    });
  }

  /**
   * Routes inbox message to pending callback using correlation ID.
   *
   * Handles:
   * - Missing correlation ID (warns and ignores)
   * - No matching handler (warns - possible timeout/cleanup race)
   * - Decoding errors (invokes callback with error)
   * - Success (invokes callback with response).
   *
   * Always cleans up pending message entry after processing.
   *
   * @param msg NATS message received in inbox subscription.
   */
  private routeReply(msg: Msg): void {
    const correlationId = msg.headers?.get(JetstreamHeaders.CorrelationId);

    if (!correlationId) {
      this.logger.warn('Received reply without correlation ID, ignoring');
      return;
    }

    const handler = this.pendingMessages.get(correlationId);

    if (!handler) {
      this.logger.warn(
        `No pending handler for correlation ID: ${correlationId} ` +
          '(possible timeout or already processed)',
      );
      return;
    }

    try {
      const response = this.codec.decode(msg.data);

      this.logger.verbose('Response payload:', response);

      handler({ err: null, response });
    } catch (error) {
      this.logger.error(`Failed to decode response (cid: ${correlationId})`, error);
      handler({ err: (error as Error).message, response: null });
    } finally {
      this.pendingMessages.delete(correlationId);
      this.logger.verbose(`Pending messages count: ${this.pendingMessages.size}`);
    }
  }

  /**
   * Creates NATS message headers with common metadata.
   *
   * Standard headers:
   * - message-id: Unique identifier for idempotency and tracing
   * - subject: Full subject name for routing and debugging.
   *
   * Optional headers:
   * - correlation-id: Links request and response for RPC pattern
   * - reply-to: Inbox address for receiving responses.
   *
   * @param data Header data configuration object.
   * @param data.messageId Unique message identifier (UUID v7).
   * @param data.subject Fully-qualified NATS subject.
   * @param data.correlationId Optional correlation ID for RPC linking.
   * @param data.replyTo Optional inbox subject for receiving responses.
   * @returns NATS message headers instance.
   */
  private createHeaders(data: {
    messageId: string;
    subject: string;
    correlationId?: string;
    replyTo?: string;
  }): MsgHdrs {
    const hdrs = headers();

    hdrs.set(JetstreamHeaders.MessageId, data.messageId);
    hdrs.set(JetstreamHeaders.Subject, data.subject);

    if (data.correlationId) {
      hdrs.set(JetstreamHeaders.CorrelationId, data.correlationId);
    }

    if (data.replyTo) {
      hdrs.set(JetstreamHeaders.ReplyTo, data.replyTo);
    }

    return hdrs;
  }

  /**
   * Builds fully-qualified NATS subject from kind and pattern.
   *
   * Format: <service-name>.<kind>.<pattern>
   * Example: "user-service.Command.get.user".
   *
   * This namespacing prevents collisions between services and message types.
   *
   * @param kind Message type (Event or Command).
   * @param pattern User-defined pattern from decorator (e.g., "get.user").
   * @returns Fully-qualified NATS subject string.
   */
  private buildSubject(kind: JetStreamKind, pattern: string): string {
    return `${this.providers.options.name}.${kind}.${pattern}`;
  }
}
