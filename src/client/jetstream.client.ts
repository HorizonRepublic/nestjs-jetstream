import { Logger } from '@nestjs/common';
import { ClientProxy, ReadPacket, WritePacket } from '@nestjs/microservices';
import { context } from '@opentelemetry/api';
import { nuid } from '@nats-io/nuid';
import {
  createInbox,
  headers as natsHeaders,
  TimeoutError,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
  type Subscription,
} from '@nats-io/transport-node';
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
  DEFAULT_JETSTREAM_RPC_TIMEOUT,
  DEFAULT_RPC_TIMEOUT,
  isCoreRpcMode,
  isJetStreamRpcMode,
  internalName,
  JetstreamHeader,
  PatternPrefix,
} from '../jetstream.constants';
import {
  beginRpcClientSpan,
  deriveOtelAttrs,
  PublishKind,
  RPC_TIMEOUT_MESSAGE,
  RpcOutcomeKind,
  withPublishSpan,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../otel';

import { JetstreamRecord } from './jetstream.record';

/** Broadcast subjects are not scoped to a service and always share this prefix. */
const BROADCAST_SUBJECT_PREFIX = 'broadcast.';

/** Narrow publish-kind tag emitted on the event path (no RPC request here). */
type EventPublishKind = Exclude<PublishKind, PublishKind.RpcRequest>;

/** Map a user event pattern to the publish-context `kind` reported in OTel spans. */
const detectEventKind = (pattern: string): EventPublishKind => {
  if (pattern.startsWith(PatternPrefix.Broadcast)) return PublishKind.Broadcast;
  if (pattern.startsWith(PatternPrefix.Ordered)) return PublishKind.Ordered;

  return PublishKind.Event;
};

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

  /**
   * Subject prefixes of the form `{serviceName}__microservice.{kind}.` — one
   * per stream kind this client may publish to. Built once in the constructor
   * so producing a full subject is a single string concat with the user pattern.
   */
  private readonly eventSubjectPrefix: string;
  private readonly commandSubjectPrefix: string;
  private readonly orderedSubjectPrefix: string;

  /**
   * RPC configuration snapshots. The values are derived from rootOptions at
   * construction time so the publish hot path never has to re-run
   * isCoreRpcMode / getRpcTimeout on every call.
   */
  private readonly isCoreMode: boolean;
  private readonly defaultRpcTimeout: number;

  /** Resolved OpenTelemetry configuration, computed once in the constructor. */
  private readonly otel: ResolvedOtelOptions;

  /** Server endpoint parts used for `server.address` / `server.port` span attributes. */
  private readonly serverEndpoint: ServerEndpoint | null;

  /** Shared inbox for JetStream-mode RPC responses. */
  private inbox: string | null = null;
  private inboxSubscription: Subscription | null = null;

  /** Pending JetStream-mode RPC callbacks, keyed by correlation ID. */
  private readonly pendingMessages = new Map<string, (p: WritePacket) => void>();

  /** Pending JetStream-mode RPC timeouts, keyed by correlation ID. */
  private readonly pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  /** Subscription to connection status events for disconnect handling. */
  private statusSubscription: RxSubscription | null = null;

  /**
   * Cached readiness flag. Once `connect()` has wired the inbox and status
   * subscription, subsequent publishes skip the `await connect()` microtask
   * and reach for the underlying connection synchronously instead.
   */
  private readyForPublish = false;

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

    const targetInternal = internalName(targetServiceName);

    this.eventSubjectPrefix = `${targetInternal}.${StreamKind.Event}.`;
    this.commandSubjectPrefix = `${targetInternal}.${StreamKind.Command}.`;
    this.orderedSubjectPrefix = `${targetInternal}.${StreamKind.Ordered}.`;

    this.isCoreMode = isCoreRpcMode(this.rootOptions.rpc);
    this.defaultRpcTimeout = isJetStreamRpcMode(this.rootOptions.rpc)
      ? (this.rootOptions.rpc?.timeout ?? DEFAULT_JETSTREAM_RPC_TIMEOUT)
      : (this.rootOptions.rpc?.timeout ?? DEFAULT_RPC_TIMEOUT);

    const derived = deriveOtelAttrs(this.rootOptions);

    this.otel = derived.otel;
    this.serverEndpoint = derived.serverEndpoint;
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

    if (!this.isCoreMode && !this.inboxSubscription) {
      this.setupInbox(nc);
    }

    this.statusSubscription ??= this.connection.status$.subscribe((status) => {
      if (status.type === 'disconnect') {
        this.handleDisconnect();
      }
    });

    this.readyForPublish = true;

    return nc;
  }

  /** Clean up resources: reject pending RPCs, unsubscribe from status events. */
  public async close(): Promise<void> {
    this.statusSubscription?.unsubscribe();
    this.statusSubscription = null;
    this.readyForPublish = false;
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
    if (!this.readyForPublish) await this.connect();
    const { data, hdrs, messageId, schedule, ttl } = this.extractRecordData(packet.data);

    const eventSubject = this.buildEventSubject(packet.pattern);
    // Replace kind segment with _sch: {svc}.ev.{pattern} → {svc}._sch.{pattern}
    // For broadcast: broadcast.{pattern} → broadcast._sch.{pattern}
    const publishSubject = schedule ? this.buildScheduleSubject(eventSubject) : eventSubject;
    const msgHeaders = this.buildHeaders(hdrs, { subject: eventSubject });
    const encoded = this.codec.encode(data);
    const effectiveMsgId = messageId ?? nuid.next();
    const record =
      packet.data instanceof JetstreamRecord ? packet.data : new JetstreamRecord(data, new Map());

    await withPublishSpan(
      {
        subject: publishSubject,
        pattern: packet.pattern,
        record,
        kind: detectEventKind(packet.pattern),
        payloadBytes: encoded.length,
        payload: encoded,
        messageId: effectiveMsgId,
        headers: msgHeaders,
        serviceName: this.callerName,
        endpoint: this.serverEndpoint,
        scheduleTarget: schedule ? eventSubject : undefined,
      },
      this.otel,
      async () => {
        if (schedule) {
          const ack = await this.connection.getJetStreamClient().publish(publishSubject, encoded, {
            headers: msgHeaders,
            msgID: effectiveMsgId,
            ttl,
            schedule: {
              specification: schedule.at,
              target: eventSubject,
            },
          });

          if (ack.duplicate) {
            this.logger.warn(
              `Duplicate scheduled publish detected: ${publishSubject} (seq: ${ack.seq})`,
            );
          }

          return;
        }

        const ack = await this.connection.getJetStreamClient().publish(publishSubject, encoded, {
          headers: msgHeaders,
          msgID: effectiveMsgId,
          ttl,
        });

        if (ack.duplicate) {
          this.logger.warn(`Duplicate event publish detected: ${publishSubject} (seq: ${ack.seq})`);
        }
      },
    );

    return undefined as T;
  }

  /**
   * Publish an RPC command and register callback for response.
   *
   * Core mode: uses nc.request() with timeout.
   * JetStream mode: publishes to stream + waits for inbox response.
   */
  protected publish(packet: ReadPacket, callback: (p: WritePacket) => void): () => void {
    const subject = this.commandSubjectPrefix + packet.pattern;
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

    if (this.isCoreMode) {
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
    const effectiveTimeout = timeout ?? this.defaultRpcTimeout;
    const hdrs = this.buildHeaders(customHeaders, { subject });
    const encoded = this.codec.encode(data);
    const spanHandle = beginRpcClientSpan(
      {
        subject,
        payloadBytes: encoded.length,
        payload: encoded,
        headers: hdrs,
        serviceName: this.callerName,
        endpoint: this.serverEndpoint,
      },
      this.otel,
    );

    try {
      const nc = this.readyForPublish
        ? (this.connection.unwrap as NatsConnection)
        : await this.connect();

      // Run the round-trip under the CLIENT span's context so any handler
      // / interceptor spans triggered by the NATS reply decode nest under
      // this span instead of the pre-existing ambient one.
      const response = await context.with(spanHandle.activeContext, () =>
        nc.request(subject, encoded, {
          timeout: effectiveTimeout,
          headers: hdrs,
        }),
      );

      const decoded = this.codec.decode(response.data);

      if (response.headers?.get(JetstreamHeader.Error)) {
        spanHandle.finish({ kind: RpcOutcomeKind.ReplyError, replyPayload: decoded });
        callback({ err: decoded, response: null, isDisposed: true });
      } else {
        spanHandle.finish({ kind: RpcOutcomeKind.Ok, reply: decoded });
        callback({ err: null, response: decoded, isDisposed: true });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');

      if (error instanceof TimeoutError) {
        spanHandle.finish({ kind: RpcOutcomeKind.Timeout });
        this.eventBus.emit(TransportEvent.RpcTimeout, subject, '');
      } else {
        spanHandle.finish({ kind: RpcOutcomeKind.Error, error });
        // Error hook + OTel CLIENT span are the canonical signals — no separate log.
        this.eventBus.emit(TransportEvent.Error, error, 'client-rpc');
      }

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
    const effectiveTimeout = options.timeout ?? this.defaultRpcTimeout;
    const hdrs = this.buildHeaders(customHeaders, {
      subject,
      correlationId,
      replyTo: this.inbox ?? '',
    });
    const encoded = this.codec.encode(data);
    const spanHandle = beginRpcClientSpan(
      {
        subject,
        correlationId,
        payloadBytes: encoded.length,
        payload: encoded,
        messageId,
        headers: hdrs,
        serviceName: this.callerName,
        endpoint: this.serverEndpoint,
      },
      this.otel,
    );

    this.pendingMessages.set(correlationId, (packet: WritePacket) => {
      // Translate the inbox-callback WritePacket into an RPC outcome. A native
      // `Error` instance reaches this path from `rejectPendingRpcs` (disconnect,
      // client close) or a decode failure in `routeInboxReply` — both are
      // transport-level failures. Any other non-empty `err` is a decoded
      // business error envelope returned by the server.
      if (packet.err) {
        if (packet.err instanceof Error) {
          spanHandle.finish({ kind: RpcOutcomeKind.Error, error: packet.err });
        } else {
          spanHandle.finish({ kind: RpcOutcomeKind.ReplyError, replyPayload: packet.err });
        }
      } else {
        spanHandle.finish({ kind: RpcOutcomeKind.Ok, reply: packet.response });
      }

      callback(packet);
    });

    // Arm the deadline BEFORE awaiting connect() so a permanent NATS outage
    // (where `maxReconnectAttempts: -1` keeps connect() pending forever) still
    // settles the span, the pending-message entry, and the caller's
    // subscription instead of leaking them for the life of the process.
    // `effectiveTimeout` therefore bounds connect + RPC, not just RPC.
    const timeoutId = setTimeout(() => {
      if (!this.pendingMessages.has(correlationId)) return;

      this.pendingTimeouts.delete(correlationId);
      this.pendingMessages.delete(correlationId);
      spanHandle.finish({ kind: RpcOutcomeKind.Timeout });
      // RpcTimeout hook + OTel CLIENT span are the canonical signals — no separate log.
      this.eventBus.emit(TransportEvent.RpcTimeout, subject, correlationId);
      callback({ err: new Error(RPC_TIMEOUT_MESSAGE), response: null, isDisposed: true });
    }, effectiveTimeout);

    this.pendingTimeouts.set(correlationId, timeoutId);

    try {
      if (!this.readyForPublish) await this.connect();

      // Bail out if cleaned up during connect (timeout fired, or consumer unsubscribed)
      if (!this.pendingMessages.has(correlationId)) return;

      if (!this.inbox) {
        clearTimeout(timeoutId);
        this.pendingTimeouts.delete(correlationId);
        this.pendingMessages.delete(correlationId);
        const inboxError = new Error('Inbox not initialized');

        spanHandle.finish({ kind: RpcOutcomeKind.Error, error: inboxError });
        callback({
          err: new Error('Inbox not initialized — JetStream RPC mode requires a connected inbox'),
          response: null,
          isDisposed: true,
        });
        return;
      }

      // Run the publish under the CLIENT span's context so any handler /
      // interceptor spans around the publish itself nest under the CLIENT
      // round-trip span rather than the ambient context.
      await context.with(spanHandle.activeContext, () =>
        this.connection.getJetStreamClient().publish(subject, encoded, {
          headers: hdrs,
          msgID: messageId ?? nuid.next(),
        }),
      );
    } catch (err) {
      const existingTimeout = this.pendingTimeouts.get(correlationId);

      if (existingTimeout) {
        clearTimeout(existingTimeout);
        this.pendingTimeouts.delete(correlationId);
      }

      if (!this.pendingMessages.has(correlationId)) return;

      this.pendingMessages.delete(correlationId);
      const error = err instanceof Error ? err : new Error('Unknown error');

      spanHandle.finish({ kind: RpcOutcomeKind.Error, error });
      this.eventBus.emit(TransportEvent.Error, error, `jetstream-rpc-publish:${subject}`);
      callback({ err: error, response: null, isDisposed: true });
    }
  }

  /** Fail-fast all pending JetStream RPC callbacks on connection loss. */
  private handleDisconnect(): void {
    this.rejectPendingRpcs(new Error('Connection lost'));

    // Reset inbox — will be recreated on next connect()
    this.inbox = null;
    // Force the next publish to re-run the full connect setup.
    this.readyForPublish = false;
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
    this.inbox = null;
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

  /**
   * Resolve a user pattern to a fully-qualified NATS subject, dispatching
   * between the event, broadcast, and ordered prefixes.
   *
   * The leading-char check short-circuits the `startsWith` comparisons for
   * patterns that cannot possibly carry a broadcast/ordered marker, which is
   * the overwhelmingly common case.
   */
  private buildEventSubject(pattern: string): string {
    if (pattern.charCodeAt(0) === 98 /* 'b' */ && pattern.startsWith(PatternPrefix.Broadcast)) {
      return BROADCAST_SUBJECT_PREFIX + pattern.slice(PatternPrefix.Broadcast.length);
    }

    if (pattern.charCodeAt(0) === 111 /* 'o' */ && pattern.startsWith(PatternPrefix.Ordered)) {
      return this.orderedSubjectPrefix + pattern.slice(PatternPrefix.Ordered.length);
    }

    return this.eventSubjectPrefix + pattern;
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
      // JetstreamRecord.headers is a ReadonlyMap on an immutable record; the
      // reference is handed through as-is because buildHeaders only reads it.
      return {
        data: rawData.data,
        hdrs: rawData.headers.size > 0 ? (rawData.headers as Map<string, string>) : null,
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
}
