import { Logger } from '@nestjs/common';
import { ClientProxy, ReadPacket, WritePacket } from '@nestjs/microservices';
import {
  createInbox,
  headers as natsHeaders,
  Msg,
  MsgHdrs,
  NatsConnection,
  Subscription,
} from 'nats';

import { ConnectionProvider } from '../connection';
import { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';
import type {
  Codec,
  ExtractedRecordData,
  JetstreamModuleOptions,
  TransportHeaderOptions,
} from '../interfaces';
import {
  buildBroadcastSubject,
  buildSubject,
  DEFAULT_RPC_TIMEOUT,
  internalName,
  JetstreamHeader,
} from '../jetstream.constants';

import { JetstreamRecord } from './jetstream.record';

/**
 * NestJS ClientProxy implementation for the JetStream transport.
 *
 * Supports two operational modes:
 * - **Core mode** (default): Uses `nc.request()` for RPC, `nc.publish()` for events.
 * - **JetStream mode**: Uses `js.publish()` for RPC commands + inbox for responses.
 *
 * Events always go through JetStream publish for guaranteed delivery.
 * The mode only affects RPC (request/reply) behavior.
 *
 * Clients are lightweight — they share the NATS connection from `forRoot()`.
 */
export class JetstreamClient extends ClientProxy {
  private readonly logger = new Logger(JetstreamClient.name);

  /** Target service name this client sends messages to. */
  private readonly targetName: string;

  /** Shared inbox for JetStream-mode RPC responses. */
  private inbox: string | null = null;
  private inboxSubscription: Subscription | null = null;

  /** Pending JetStream-mode RPC callbacks, keyed by correlation ID. */
  private readonly pendingMessages = new Map<string, (p: WritePacket) => void>();

  /** Pending JetStream-mode RPC timeouts, keyed by correlation ID. */
  private readonly pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  public constructor(
    private readonly rootOptions: JetstreamModuleOptions,
    targetServiceName: string,
    private readonly connection: ConnectionProvider,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
  ) {
    super();
    this.targetName = targetServiceName;
  }

  /** Establish connection. Called automatically by NestJS on first use. */
  public async connect(): Promise<NatsConnection> {
    const nc = await this.connection.getConnection();

    // Setup inbox for JetStream RPC mode
    if (this.isJetStreamRpcMode() && !this.inboxSubscription) {
      this.setupInbox(nc);
    }

    return nc;
  }

  /** Clean up resources. */
  public async close(): Promise<void> {
    this.inboxSubscription?.unsubscribe();
    this.inboxSubscription = null;

    for (const timeoutId of this.pendingTimeouts.values()) {
      clearTimeout(timeoutId);
    }

    this.pendingTimeouts.clear();
    this.pendingMessages.clear();
  }

  /** Direct access to the raw NATS connection. */
  public override unwrap<T = NatsConnection>(): T {
    return this.connection.unwrap as T;
  }

  /**
   * Publish a fire-and-forget event to JetStream.
   *
   * Events are published to either the workqueue stream or broadcast stream
   * depending on the subject prefix.
   */
  protected async dispatchEvent<T = unknown>(packet: ReadPacket): Promise<T> {
    const nc = await this.connect();
    const { data, hdrs } = this.extractRecordData(packet.data);

    // Determine if this is a broadcast event
    // Broadcast subjects start with 'broadcast:'
    const subject = this.buildEventSubject(packet.pattern);
    const messageId = crypto.randomUUID();

    const msgHeaders = this.buildHeaders(hdrs, { messageId, subject });

    await nc.jetstream().publish(subject, this.codec.encode(data), {
      headers: msgHeaders,
    });

    return undefined as T;
  }

  /**
   * Publish an RPC command and register callback for response.
   *
   * Core mode: uses nc.request() with timeout.
   * JetStream mode: publishes to stream + waits for inbox response.
   */
  protected publish(packet: ReadPacket, callback: (p: WritePacket) => void): () => void {
    const subject = buildSubject(this.targetName, 'cmd', packet.pattern);
    const { data, hdrs, timeout } = this.extractRecordData(packet.data);

    const onUnhandled = (err: unknown): void => {
      this.logger.error('Unhandled publish error:', err);
      callback({ err: 'Internal transport error', response: null, isDisposed: true });
    };

    // Track correlation ID for cleanup in JetStream mode
    let jetStreamCorrelationId: string | null = null;

    if (this.isCoreRpcMode()) {
      this.publishCoreRpc(subject, data, hdrs, timeout, callback).catch(onUnhandled);
    } else {
      jetStreamCorrelationId = crypto.randomUUID();
      this.publishJetStreamRpc(subject, data, hdrs, callback, jetStreamCorrelationId).catch(
        onUnhandled,
      );
    }

    return () => {
      // Cleanup for JetStream mode pending messages
      // Core mode cleanup is handled by NATS internally
      if (jetStreamCorrelationId) {
        const timeoutId = this.pendingTimeouts.get(jetStreamCorrelationId);

        if (timeoutId) {
          clearTimeout(timeoutId);
          this.pendingTimeouts.delete(jetStreamCorrelationId);
        }

        this.pendingMessages.delete(jetStreamCorrelationId);
      }
    };
  }

  /** Core mode: nc.request() with timeout. */
  private async publishCoreRpc(
    subject: string,
    data: unknown,
    customHeaders: Map<string, string> | null,
    timeout: number | undefined,
    callback: (p: WritePacket) => void,
  ): Promise<void> {
    try {
      const nc = await this.connect();
      const effectiveTimeout = timeout ?? this.getRpcTimeout();
      const messageId = crypto.randomUUID();

      const hdrs = this.buildHeaders(customHeaders, { messageId, subject });

      const response = await nc.request(subject, this.codec.encode(data), {
        timeout: effectiveTimeout,
        headers: hdrs,
      });

      const decoded = this.codec.decode(response.data);

      callback({ err: null, response: decoded, isDisposed: true });
    } catch (err) {
      this.logger.error(`Core RPC error (${subject}):`, err);
      this.eventBus.emit(
        TransportEvent.Error,
        err instanceof Error ? err : new Error(String(err)),
        'client-rpc',
      );
      callback({
        err: err instanceof Error ? err.message : 'Unknown error',
        response: null,
        isDisposed: true,
      });
    }
  }

  /** JetStream mode: publish to stream + wait for inbox response. */
  private async publishJetStreamRpc(
    subject: string,
    data: unknown,
    customHeaders: Map<string, string> | null,
    callback: (p: WritePacket) => void,
    correlationId: string = crypto.randomUUID(),
  ): Promise<void> {
    const messageId = crypto.randomUUID();

    this.pendingMessages.set(correlationId, callback);

    const timeoutId = setTimeout(() => {
      this.pendingTimeouts.delete(correlationId);
      this.pendingMessages.delete(correlationId);
      this.logger.error(`JetStream RPC timeout (${this.getRpcTimeout()}ms): ${subject}`);
      this.eventBus.emit(TransportEvent.RpcTimeout, subject, correlationId);
      callback({ err: 'RPC timeout', response: null, isDisposed: true });
    }, this.getRpcTimeout());

    this.pendingTimeouts.set(correlationId, timeoutId);

    try {
      const nc = await this.connect();

      if (!this.inbox) {
        throw new Error('Inbox not initialized — JetStream RPC mode requires a connected inbox');
      }

      const hdrs = this.buildHeaders(customHeaders, {
        messageId,
        subject,
        correlationId,
        replyTo: this.inbox,
      });

      await nc.jetstream().publish(subject, this.codec.encode(data), {
        headers: hdrs,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      this.pendingTimeouts.delete(correlationId);
      this.logger.error(`JetStream RPC publish error (${subject}):`, err);
      callback({
        err: err instanceof Error ? err.message : 'Unknown error',
        response: null,
        isDisposed: true,
      });
      this.pendingMessages.delete(correlationId);
    }
  }

  /** Setup shared inbox subscription for JetStream RPC responses. */
  private setupInbox(nc: NatsConnection): void {
    this.inbox = createInbox(internalName(this.rootOptions.name));

    this.inboxSubscription = nc.subscribe(this.inbox, {
      callback: (err, msg) => {
        if (err) {
          this.logger.error('Inbox subscription error:', err);
          return;
        }

        this.routeInboxReply(msg);
      },
    });

    this.logger.debug(`Inbox subscription: ${this.inbox}`);
  }

  /** Route an inbox reply to the matching pending callback. */
  private routeInboxReply(msg: Msg): void {
    const correlationId = msg.headers?.get(JetstreamHeader.CorrelationId);

    if (!correlationId) {
      this.logger.warn('Inbox reply without correlation-id, ignoring');
      return;
    }

    const callback = this.pendingMessages.get(correlationId);

    if (!callback) {
      this.logger.warn(`No pending handler for correlation-id: ${correlationId}`);
      return;
    }

    const timeoutId = this.pendingTimeouts.get(correlationId);

    if (timeoutId) {
      clearTimeout(timeoutId);
      this.pendingTimeouts.delete(correlationId);
    }

    try {
      const response = this.codec.decode(msg.data);

      callback({ err: null, response, isDisposed: true });
    } catch (err) {
      callback({
        err: err instanceof Error ? err.message : 'Decode error',
        response: null,
        isDisposed: true,
      });
    } finally {
      this.pendingMessages.delete(correlationId);
    }
  }

  /** Build event subject — workqueue or broadcast. */
  private buildEventSubject(pattern: string): string {
    // Convention: 'broadcast:' prefix routes to the shared broadcast stream.
    // The prefix is stripped and the pattern is published to broadcast.{pattern}.
    // Example: 'broadcast:user.created' → 'broadcast.user.created'
    if (pattern.startsWith('broadcast:')) {
      return buildBroadcastSubject(pattern.slice('broadcast:'.length));
    }

    return buildSubject(this.targetName, 'ev', pattern);
  }

  /** Build NATS headers merging custom headers with transport headers. */
  private buildHeaders(
    customHeaders: Map<string, string> | null,
    transport: TransportHeaderOptions,
  ): MsgHdrs {
    const hdrs = natsHeaders();

    // Set transport headers
    hdrs.set(JetstreamHeader.MessageId, transport.messageId);
    hdrs.set(JetstreamHeader.Subject, transport.subject);
    hdrs.set(JetstreamHeader.CallerName, internalName(this.rootOptions.name));

    if (transport.correlationId) {
      hdrs.set(JetstreamHeader.CorrelationId, transport.correlationId);
    }

    if (transport.replyTo) {
      hdrs.set(JetstreamHeader.ReplyTo, transport.replyTo);
    }

    // Merge user headers (reserved headers already validated by JetstreamRecordBuilder)
    if (customHeaders) {
      for (const [key, value] of customHeaders) {
        hdrs.set(key, value);
      }
    }

    return hdrs;
  }

  /** Extract data, headers, and timeout from raw packet data or JetstreamRecord. */
  private extractRecordData(rawData: unknown): ExtractedRecordData {
    if (rawData instanceof JetstreamRecord) {
      return {
        data: rawData.data,
        hdrs: rawData.headers.size > 0 ? new Map(rawData.headers) : null,
        timeout: rawData.timeout,
      };
    }

    return { data: rawData, hdrs: null, timeout: undefined };
  }

  private isCoreRpcMode(): boolean {
    return !this.rootOptions.rpc || this.rootOptions.rpc.mode === 'core';
  }

  private isJetStreamRpcMode(): boolean {
    return this.rootOptions.rpc?.mode === 'jetstream';
  }

  private getRpcTimeout(): number {
    if (!this.rootOptions.rpc) return DEFAULT_RPC_TIMEOUT;
    return this.rootOptions.rpc.timeout ?? DEFAULT_RPC_TIMEOUT;
  }
}
