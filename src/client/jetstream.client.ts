import { Logger } from '@nestjs/common';
import { ClientProxy, ReadPacket, WritePacket } from '@nestjs/microservices';
import {
  createInbox,
  headers as natsHeaders,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
  type Subscription,
} from '@nats-io/transport-node';
import { nuid } from '@nats-io/nuid';
import { Subscription as RxSubscription } from 'rxjs';

import { ConnectionProvider } from '../connection';
import { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';
import type {
  Codec,
  ExtractedRecordData,
  JetstreamModuleOptions,
  TransportHeaderOptions,
} from '../interfaces';
import { StreamKind } from '../interfaces';
import {
  buildBroadcastSubject,
  buildSubject,
  DEFAULT_JETSTREAM_RPC_TIMEOUT,
  DEFAULT_RPC_TIMEOUT,
  isCoreRpcMode,
  isJetStreamRpcMode,
  internalName,
  JetstreamHeader,
  PatternPrefix,
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
  private readonly logger = new Logger('Jetstream:Client');

  /** Target service name this client sends messages to. */
  private readonly targetName: string;

  /** Pre-cached caller name derived from rootOptions.name, computed once in constructor. */
  private readonly callerName: string;

  /** Shared inbox for JetStream-mode RPC responses. */
  private inbox: string | null = null;
  private inboxSubscription: Subscription | null = null;

  /** Pending JetStream-mode RPC callbacks, keyed by correlation ID. */
  private readonly pendingMessages = new Map<string, (p: WritePacket) => void>();

  /** Pending JetStream-mode RPC timeouts, keyed by correlation ID. */
  private readonly pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  /** Subscription to connection status events for disconnect handling. */
  private statusSubscription: RxSubscription | null = null;

  public constructor(
    private readonly rootOptions: JetstreamModuleOptions,
    targetServiceName: string,
    private readonly connection: ConnectionProvider,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
  ) {
    super();
    this.targetName = targetServiceName;
    this.callerName = internalName(this.rootOptions.name);
  }

  /**
   * Establish connection. Called automatically by NestJS on first use.
   *
   * Sets up the JetStream RPC inbox (if in JetStream mode) and subscribes
   * to connection status events for fail-fast disconnect handling.
   *
   * @returns The underlying NATS connection.
   */
  public async connect(): Promise<NatsConnection> {
    const nc = await this.connection.getConnection();

    if (isJetStreamRpcMode(this.rootOptions.rpc) && !this.inboxSubscription) {
      this.setupInbox(nc);
    }

    this.statusSubscription ??= this.connection.status$.subscribe((status) => {
      if (status.type === 'disconnect') {
        this.handleDisconnect();
      }
    });

    return nc;
  }

  /** Clean up resources: reject pending RPCs, unsubscribe from status events. */
  public async close(): Promise<void> {
    this.statusSubscription?.unsubscribe();
    this.statusSubscription = null;
    this.rejectPendingRpcs(new Error('Client closed'));
  }

  /**
   * Direct access to the raw NATS connection.
   *
   * @throws Error if not connected.
   */
  public override unwrap<T = NatsConnection>(): T {
    const nc = this.connection.unwrap;

    if (!nc) {
      throw new Error('Not connected — call connect() before unwrap()');
    }

    return nc as T;
  }

  /**
   * Publish a fire-and-forget event to JetStream.
   *
   * Events are published to either the workqueue stream or broadcast stream
   * depending on the subject prefix. When a schedule is present the message
   * is published to a `_sch` subject within the same stream, with the target
   * set to the original event subject.
   */
  protected async dispatchEvent<T = unknown>(packet: ReadPacket): Promise<T> {
    await this.connect();
    const { data, hdrs, messageId, schedule, ttl } = this.extractRecordData(packet.data);

    const eventSubject = this.buildEventSubject(packet.pattern);
    const msgHeaders = this.buildHeaders(hdrs, { subject: eventSubject });

    if (schedule) {
      // Replace kind segment with _sch: {svc}.ev.{pattern} → {svc}._sch.{pattern}
      // For broadcast: broadcast.{pattern} → broadcast._sch.{pattern}
      const scheduleSubject = this.buildScheduleSubject(eventSubject);

      const ack = await this.connection
        .getJetStreamClient()
        .publish(scheduleSubject, this.codec.encode(data), {
          headers: msgHeaders,
          msgID: messageId ?? nuid.next(),
          ttl,
          schedule: {
            specification: schedule.at,
            target: eventSubject,
          },
        });

      if (ack.duplicate) {
        this.logger.warn(
          `Duplicate scheduled publish detected: ${scheduleSubject} (seq: ${ack.seq})`,
        );
      }
    } else {
      const ack = await this.connection
        .getJetStreamClient()
        .publish(eventSubject, this.codec.encode(data), {
          headers: msgHeaders,
          msgID: messageId ?? nuid.next(),
          ttl,
        });

      if (ack.duplicate) {
        this.logger.warn(`Duplicate event publish detected: ${eventSubject} (seq: ${ack.seq})`);
      }
    }

    return undefined as T;
  }

  /**
   * Publish an RPC command and register callback for response.
   *
   * Core mode: uses nc.request() with timeout.
   * JetStream mode: publishes to stream + waits for inbox response.
   */
  protected publish(packet: ReadPacket, callback: (p: WritePacket) => void): () => void {
    const subject = buildSubject(this.targetName, StreamKind.Command, packet.pattern);
    const { data, hdrs, timeout, messageId, schedule, ttl } = this.extractRecordData(packet.data);

    if (schedule) {
      this.logger.warn(
        'scheduleAt() is ignored for RPC (client.send()). Use client.emit() for scheduled events.',
      );
    }

    if (ttl) {
      this.logger.warn(
        'ttl() is ignored for RPC (client.send()). Use client.emit() for events with TTL.',
      );
    }

    const onUnhandled = (err: unknown): void => {
      this.logger.error('Unhandled publish error:', err);
      callback({ err: new Error('Internal transport error'), response: null, isDisposed: true });
    };

    // Track correlation ID for cleanup in JetStream mode
    let jetStreamCorrelationId: string | null = null;

    if (isCoreRpcMode(this.rootOptions.rpc)) {
      this.publishCoreRpc(subject, data, hdrs, timeout, callback).catch(onUnhandled);
    } else {
      jetStreamCorrelationId = nuid.next();
      this.publishJetStreamRpc(subject, data, callback, {
        headers: hdrs,
        timeout,
        correlationId: jetStreamCorrelationId,
        messageId,
      }).catch(onUnhandled);
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
      const hdrs = this.buildHeaders(customHeaders, { subject });

      const response = await nc.request(subject, this.codec.encode(data), {
        timeout: effectiveTimeout,
        headers: hdrs,
      });

      const decoded = this.codec.decode(response.data);

      if (response.headers?.get(JetstreamHeader.Error)) {
        callback({ err: decoded, response: null, isDisposed: true });
      } else {
        callback({ err: null, response: decoded, isDisposed: true });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');

      this.logger.error(`Core RPC error (${subject}):`, err);
      this.eventBus.emit(TransportEvent.Error, error, 'client-rpc');
      callback({ err: error, response: null, isDisposed: true });
    }
  }

  /** JetStream mode: publish to stream + wait for inbox response. */
  private async publishJetStreamRpc(
    subject: string,
    data: unknown,
    callback: (p: WritePacket) => void,
    options: {
      headers: Map<string, string> | null;
      timeout: number | undefined;
      correlationId: string;
      messageId?: string;
    },
  ): Promise<void> {
    const { headers: customHeaders, correlationId, messageId } = options;
    const effectiveTimeout = options.timeout ?? this.getRpcTimeout();

    this.pendingMessages.set(correlationId, callback);

    try {
      await this.connect();

      // Bail out if cleaned up during connect (e.g. consumer unsubscribed)
      if (!this.pendingMessages.has(correlationId)) return;

      if (!this.inbox) {
        this.pendingMessages.delete(correlationId);
        callback({
          err: new Error('Inbox not initialized — JetStream RPC mode requires a connected inbox'),
          response: null,
          isDisposed: true,
        });
        return;
      }

      // Start timeout AFTER connect — measures actual RPC wait time, not connect + RPC
      const timeoutId = setTimeout(() => {
        if (!this.pendingMessages.has(correlationId)) return;

        this.pendingTimeouts.delete(correlationId);
        this.pendingMessages.delete(correlationId);
        this.logger.error(`JetStream RPC timeout (${effectiveTimeout}ms): ${subject}`);
        this.eventBus.emit(TransportEvent.RpcTimeout, subject, correlationId);
        callback({ err: new Error('RPC timeout'), response: null, isDisposed: true });
      }, effectiveTimeout);

      this.pendingTimeouts.set(correlationId, timeoutId);

      const hdrs = this.buildHeaders(customHeaders, {
        subject,
        correlationId,
        replyTo: this.inbox,
      });

      await this.connection.getJetStreamClient().publish(subject, this.codec.encode(data), {
        headers: hdrs,
        msgID: messageId ?? nuid.next(),
      });
    } catch (err) {
      const existingTimeout = this.pendingTimeouts.get(correlationId);

      if (existingTimeout) {
        clearTimeout(existingTimeout);
        this.pendingTimeouts.delete(correlationId);
      }

      if (!this.pendingMessages.has(correlationId)) return;

      this.pendingMessages.delete(correlationId);
      const error = err instanceof Error ? err : new Error('Unknown error');

      this.logger.error(`JetStream RPC publish error (${subject}):`, err);
      callback({ err: error, response: null, isDisposed: true });
    }
  }

  /** Fail-fast all pending JetStream RPC callbacks on connection loss. */
  private handleDisconnect(): void {
    this.rejectPendingRpcs(new Error('Connection lost'));

    // Reset inbox — will be recreated on next connect()
    this.inbox = null;
  }

  /** Reject all pending RPC callbacks, clear timeouts, and tear down inbox. */
  private rejectPendingRpcs(error: Error): void {
    for (const callback of this.pendingMessages.values()) {
      callback({ err: error, response: null, isDisposed: true });
    }

    for (const timeoutId of this.pendingTimeouts.values()) {
      clearTimeout(timeoutId);
    }

    this.pendingMessages.clear();
    this.pendingTimeouts.clear();
    this.inboxSubscription?.unsubscribe();
    this.inboxSubscription = null;
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
      const decoded = this.codec.decode(msg.data);

      if (msg.headers?.get(JetstreamHeader.Error)) {
        callback({ err: decoded, response: null, isDisposed: true });
      } else {
        callback({ err: null, response: decoded, isDisposed: true });
      }
    } catch (err) {
      callback({
        err: err instanceof Error ? err : new Error('Decode error'),
        response: null,
        isDisposed: true,
      });
    } finally {
      this.pendingMessages.delete(correlationId);
    }
  }

  /** Build event subject — workqueue, broadcast, or ordered. */
  private buildEventSubject(pattern: string): string {
    if (pattern.startsWith(PatternPrefix.Broadcast)) {
      return buildBroadcastSubject(pattern.slice(PatternPrefix.Broadcast.length));
    }

    if (pattern.startsWith(PatternPrefix.Ordered)) {
      return buildSubject(
        this.targetName,
        StreamKind.Ordered,
        pattern.slice(PatternPrefix.Ordered.length),
      );
    }

    return buildSubject(this.targetName, StreamKind.Event, pattern);
  }

  /** Build NATS headers merging custom headers with transport headers. */
  private buildHeaders(
    customHeaders: Map<string, string> | null,
    transport: TransportHeaderOptions,
  ): MsgHdrs {
    const hdrs = natsHeaders();

    // Set transport headers
    hdrs.set(JetstreamHeader.Subject, transport.subject);
    hdrs.set(JetstreamHeader.CallerName, this.callerName);

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

  /** Extract data, headers, timeout, and schedule from raw packet data or JetstreamRecord. */
  private extractRecordData(rawData: unknown): ExtractedRecordData {
    if (rawData instanceof JetstreamRecord) {
      return {
        data: rawData.data,
        hdrs: rawData.headers.size > 0 ? new Map(rawData.headers) : null,
        timeout: rawData.timeout,
        messageId: rawData.messageId,
        schedule: rawData.schedule,
        ttl: rawData.ttl,
      };
    }

    return {
      data: rawData,
      hdrs: null,
      timeout: undefined,
      messageId: undefined,
      schedule: undefined,
      ttl: undefined,
    };
  }

  /**
   * Build a schedule-holder subject for NATS message scheduling.
   *
   * The schedule-holder subject resides in the same stream as the target but
   * uses a separate `_sch` namespace that is NOT matched by any consumer filter.
   * NATS holds the message and publishes it to the target subject after the delay.
   *
   * Examples:
   * - `{svc}__microservice.ev.order.reminder` → `{svc}__microservice._sch.order.reminder`
   * - `broadcast.config.updated` → `broadcast._sch.config.updated`
   */
  private buildScheduleSubject(eventSubject: string): string {
    if (eventSubject.startsWith('broadcast.')) {
      return eventSubject.replace('broadcast.', 'broadcast._sch.');
    }

    // For event/ordered subjects: {svc}__microservice.{kind}.{pattern}
    // Replace the kind segment with _sch: {svc}__microservice._sch.{pattern}
    const targetPrefix = `${internalName(this.targetName)}.`;

    if (!eventSubject.startsWith(targetPrefix)) {
      throw new Error(`Unexpected event subject format: ${eventSubject}`);
    }

    const withoutPrefix = eventSubject.slice(targetPrefix.length);
    // withoutPrefix is "{kind}.{pattern}" — strip the kind segment
    const dotIndex = withoutPrefix.indexOf('.');

    if (dotIndex === -1) {
      throw new Error(`Event subject missing pattern segment: ${eventSubject}`);
    }

    const pattern = withoutPrefix.slice(dotIndex + 1);

    return `${targetPrefix}_sch.${pattern}`;
  }

  private getRpcTimeout(): number {
    if (!this.rootOptions.rpc) return DEFAULT_RPC_TIMEOUT;

    const defaultTimeout = isJetStreamRpcMode(this.rootOptions.rpc)
      ? DEFAULT_JETSTREAM_RPC_TIMEOUT
      : DEFAULT_RPC_TIMEOUT;

    return this.rootOptions.rpc.timeout ?? defaultTimeout;
  }
}
