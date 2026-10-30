import { Logger } from '@nestjs/common';
import { ClientProxy, ReadPacket, WritePacket } from '@nestjs/microservices';

import { nuid } from '@nats-io/nuid';
import { headers as natsHeaders, type MsgHdrs, type NatsConnection } from '@nats-io/transport-node';

import { Subscription as RxSubscription } from 'rxjs';

import { ConnectionProvider } from '../connection';
import { NatsCapability } from '../connection/server-capabilities.types';
import {
  ConfigErrorReason,
  ConnectionErrorReason,
  JetstreamConfigError,
  JetstreamConnectionError,
  JetstreamRecordError,
  JetstreamRpcError,
  RecordErrorReason,
  RpcErrorReason,
  toPublishError,
} from '../errors';
import { EventBus } from '../hooks';
import type {
  ClientScheduleSpec,
  Codec,
  ExtractedRecordData,
  JetstreamModuleOptions,
  ScheduleChange,
  ScheduleInfo,
  TargetSubjectPrefixes,
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
  deriveOtelAttrs,
  PublishKind,
  withPublishSpan,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../otel';
import { ScheduleClient } from '../schedule/schedule-client';
import { NameResolver } from '../server/infrastructure/name-resolver';
import { SubjectResolver } from '../server/infrastructure/subject-resolver';
import { ClientReporter } from './client-reporter';
import type { PublishAckLike } from './client.types';
import { assertHeaderAllowed, JetstreamRecord } from './jetstream.record';
import { RpcDispatcher } from './rpc-dispatcher';
import { RpcReplyInbox } from './rpc-reply-inbox';

/**
 * Subjects a client publishes to. A foreign target is resolved from the
 * prefixes passed to `forFeature()`; the service itself already knows its own.
 */
const resolveTargetSubjects = (
  target: string,
  targetPrefixes: TargetSubjectPrefixes | undefined,
  own: NameResolver,
  isSelf: boolean,
): SubjectResolver => {
  if (!isSelf) {
    return SubjectResolver.forTarget(
      target,
      {
        [StreamKind.Event]: targetPrefixes?.events,
        [StreamKind.Ordered]: targetPrefixes?.ordered,
        [StreamKind.Command]: targetPrefixes?.rpc,
        [StreamKind.Schedule]: targetPrefixes?.schedule,
      },
      own.subjects,
    );
  }

  if (targetPrefixes !== undefined) {
    throw new JetstreamConfigError(
      ConfigErrorReason.SelfTargetPrefix,
      `forFeature({ name: '${target}' }) targets this service itself, so it takes no subjectPrefix: ` +
        'its prefixes come from forRoot().',
    );
  }

  return own.subjects;
};

/** Narrow publish-kind tag emitted on the event path (no RPC request here). */
type EventPublishKind = Exclude<PublishKind, PublishKind.RpcRequest>;

/** Map a user event pattern to the publish-context `kind` reported in OTel spans. */
const detectEventKind = (pattern: string): EventPublishKind => {
  if (pattern.startsWith(PatternPrefix.Broadcast)) return PublishKind.Broadcast;
  if (pattern.startsWith(PatternPrefix.Ordered)) return PublishKind.Ordered;

  return PublishKind.Event;
};

/** Strip the broadcast/ordered prefix so metric labels match the handler-side declaration. */
const declaredEventPattern = (pattern: string, kind: EventPublishKind): string => {
  if (kind === PublishKind.Broadcast) return pattern.slice(PatternPrefix.Broadcast.length);
  if (kind === PublishKind.Ordered) return pattern.slice(PatternPrefix.Ordered.length);

  return pattern;
};

/** Map an event-side {@link PublishKind} to its corresponding {@link StreamKind}. */
const eventStreamKind = (kind: EventPublishKind): StreamKind => {
  if (kind === PublishKind.Broadcast) return StreamKind.Broadcast;
  if (kind === PublishKind.Ordered) return StreamKind.Ordered;

  return StreamKind.Event;
};

/**
 * NestJS ClientProxy implementation for the JetStream transport.
 *
 * Supports two operational modes:
 * - **Core mode** (default): Uses `nc.request()` for RPC.
 * - **JetStream mode**: Uses `js.publish()` for RPC commands + inbox for responses.
 *
 * Events always publish through JetStream and await a PubAck, in either mode.
 *
 * Events always go through JetStream publish for guaranteed delivery.
 * The mode only affects RPC (request/reply) behavior.
 *
 * Clients are lightweight: they share the NATS connection from `forRoot()`.
 */
export class JetstreamClient extends ClientProxy {
  private readonly logger = new Logger('Jetstream:Client');

  /** Pre-cached caller name derived from rootOptions.name, computed once in constructor. */
  private readonly callerName: string;

  /** Subjects of the target service: its own resolver when the target is this service. */
  private readonly subjects: SubjectResolver;

  /** Dynamic schedules on the target, created on first use. */
  private scheduleClient: ScheduleClient | null = null;

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

  /** Reply inbox and pending-request registry for JetStream-mode RPC. */
  private readonly rpcInbox: RpcReplyInbox;

  private readonly reporter: ClientReporter;
  private readonly rpc: RpcDispatcher;

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
    eventBus: EventBus,
    names?: NameResolver,
    targetPrefixes?: TargetSubjectPrefixes,
  ) {
    super();
    this.callerName = internalName(this.rootOptions.name);
    this.subjects = resolveTargetSubjects(
      targetServiceName,
      targetPrefixes,
      names ?? new NameResolver(rootOptions),
      targetServiceName === rootOptions.name,
    );

    this.rpcInbox = new RpcReplyInbox(codec, this.callerName);
    this.isCoreMode = isCoreRpcMode(this.rootOptions.rpc);
    this.defaultRpcTimeout = isJetStreamRpcMode(this.rootOptions.rpc)
      ? (this.rootOptions.rpc.timeout ?? DEFAULT_JETSTREAM_RPC_TIMEOUT)
      : (this.rootOptions.rpc?.timeout ?? DEFAULT_RPC_TIMEOUT);

    const derived = deriveOtelAttrs(this.rootOptions);

    this.otel = derived.otel;
    this.serverEndpoint = derived.serverEndpoint;

    this.reporter = new ClientReporter(eventBus);
    this.rpc = new RpcDispatcher({
      connection,
      codec,
      eventBus,
      reporter: this.reporter,
      inbox: this.rpcInbox,
      otel: this.otel,
      serverEndpoint: this.serverEndpoint,
      callerName: this.callerName,
      defaultTimeout: this.defaultRpcTimeout,
      isReady: (): boolean => this.readyForPublish,
      connect: (): Promise<NatsConnection> => this.connect(),
      buildHeaders: (customHeaders, transport): MsgHdrs =>
        this.buildHeaders(customHeaders, transport),
    });
  }

  /**
   * Establish connection. Called automatically by NestJS on first use.
   *
   * Sets up the JetStream RPC inbox (if in JetStream mode) and subscribes
   * to connection status events to fail pending calls once the connection closes.
   *
   * @returns The underlying NATS connection.
   */
  public async connect(): Promise<NatsConnection> {
    const nc = await this.connection.getConnection();

    if (!this.isCoreMode && !this.rpcInbox.active) {
      this.rpcInbox.setup(nc);
    }

    // A disconnect is left alone: JetStream-mode commands are already persisted
    // and nats.js resubscribes the inbox on reconnect, so their replies still
    // arrive, and every call stays bounded by its deadline.
    this.statusSubscription ??= this.connection.status$.subscribe((status) => {
      if (status.type === 'close') {
        this.handleClose();
      }
    });

    this.readyForPublish = true;

    return nc;
  }

  /**
   * Create or replace a schedule on the target service. Its ticks go to the
   * target's handler for `pattern`, which declares `schedule` in its extras.
   *
   * An unchanged schedule is left alone, so an interval keeps its phase.
   *
   * @param id One subject token naming the schedule, unique within the target.
   * @throws JetstreamScheduleError for an invalid id, pattern or spec, or a server too old for it.
   */
  public async schedule(
    id: string,
    pattern: string,
    data: unknown,
    spec: ClientScheduleSpec,
  ): Promise<ScheduleChange> {
    return this.schedules().schedule(id, pattern, data, spec);
  }

  /** Cancel a schedule created with {@link schedule}; nothing happens when it does not exist. */
  public async cancelSchedule(id: string): Promise<void> {
    await this.schedules().cancelSchedule(id);
  }

  /** Every schedule of the target service, declared by its handlers and created by clients. */
  public async listSchedules(): Promise<ScheduleInfo[]> {
    return this.schedules().listSchedules();
  }

  /** Clean up resources: reject pending RPCs, unsubscribe from status events. */
  public async close(): Promise<void> {
    this.statusSubscription?.unsubscribe();
    this.statusSubscription = null;
    this.readyForPublish = false;
    this.rpcInbox.rejectAll(new JetstreamRpcError(RpcErrorReason.ClientClosed, 'Client closed'));
  }

  /**
   * Direct access to the raw NATS connection.
   *
   * @throws Error if not connected.
   */
  public unwrap<T = NatsConnection>(): T {
    const nc = this.connection.unwrap;

    if (!nc) {
      throw new JetstreamConnectionError(
        ConnectionErrorReason.NotConnected,
        'Not connected; call connect() before unwrap()',
      );
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

    const publishKind = detectEventKind(packet.pattern);

    if (schedule && publishKind === PublishKind.Ordered) {
      // ADR-51: the schedule target must live in the same stream as the holder, impossible for ordered patterns.
      throw new JetstreamRecordError(
        RecordErrorReason.ScheduleUnsupportedForOrdered,
        `scheduleAt() is not supported for ordered events (pattern: ${packet.pattern}). ` +
          'Scheduled delivery is available for workqueue events and broadcasts.',
      );
    }

    // Older servers accept both headers and silently drop them.
    if (schedule) {
      await this.assertSupported(NatsCapability.MessageSchedules, 'scheduleAt()');
    } else if (ttl !== undefined) {
      await this.assertSupported(NatsCapability.MessageTtl, 'ttl()');
    }

    const eventSubject = this.buildEventSubject(packet.pattern);
    // Replace kind segment with _sch: {svc}.ev.{pattern} -> {svc}._sch.{pattern}
    // For broadcast: broadcast.{pattern} -> broadcast._sch.{pattern}
    const publishSubject = schedule ? this.buildScheduleSubject(eventSubject) : eventSubject;
    const msgHeaders = this.buildHeaders(hdrs, { subject: eventSubject });
    const encoded = this.codec.encode(data);
    const effectiveMsgId = messageId ?? nuid.next();
    const record =
      packet.data instanceof JetstreamRecord ? packet.data : new JetstreamRecord(data, new Map());

    const declaredPattern = declaredEventPattern(packet.pattern, publishKind);
    const streamKind = eventStreamKind(publishKind);
    const startedAt = performance.now();

    try {
      await withPublishSpan(
        {
          subject: publishSubject,
          pattern: packet.pattern,
          record,
          kind: publishKind,
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
            // As a top-level option ttl would expire the schedule holder itself; it belongs to the delivered message.
            const ack = await this.connection
              .getJetStreamClient()
              .publish(publishSubject, encoded, {
                headers: msgHeaders,
                msgID: effectiveMsgId,
                schedule: {
                  specification: schedule.at,
                  target: eventSubject,
                  ttl,
                },
              });

            this.warnIfDuplicate('scheduled', publishSubject, ack);

            return;
          }

          const ack = await this.connection.getJetStreamClient().publish(publishSubject, encoded, {
            headers: msgHeaders,
            msgID: effectiveMsgId,
            ttl,
          });

          this.warnIfDuplicate('event', publishSubject, ack);
        },
      );
      this.reporter.published(declaredPattern, streamKind, startedAt, 'success');
    } catch (err) {
      this.reporter.published(declaredPattern, streamKind, startedAt, 'error');
      throw toPublishError(err);
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
    const subject = this.subjects.subject(StreamKind.Command, packet.pattern);
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
      callback({
        err: new JetstreamRpcError(RpcErrorReason.InternalTransport, 'Internal transport error', {
          cause: err,
        }),
        response: null,
        isDisposed: true,
      });
    };

    let jetStreamCorrelationId: string | null = null;

    const request = { subject, data, headers: hdrs, timeout, declaredPattern: packet.pattern };

    if (this.isCoreMode) {
      this.rpc.publishCore(request, callback).catch(onUnhandled);
    } else {
      jetStreamCorrelationId = nuid.next();
      this.rpc
        .publishJetStream(
          { ...request, correlationId: jetStreamCorrelationId, messageId },
          callback,
        )
        .catch(onUnhandled);
    }

    return () => {
      // Core mode cleanup is handled by NATS internally; only JetStream pending state needs it.
      if (jetStreamCorrelationId) {
        this.rpcInbox.cancel(jetStreamCorrelationId);
      }
    };
  }

  private warnIfDuplicate(kindLabel: string, subject: string, ack: PublishAckLike): void {
    if (ack.duplicate) {
      this.logger.warn(`Duplicate ${kindLabel} publish detected: ${subject} (seq: ${ack.seq})`);
    }
  }

  /** Fail every pending JetStream RPC once the connection is closed for good. */
  private handleClose(): void {
    // The inbox is recreated on the next connect().
    this.rpcInbox.rejectAll(
      new JetstreamRpcError(RpcErrorReason.ConnectionLost, 'Connection lost'),
    );
    // Force the next publish through connect(), which dials a new connection.
    this.readyForPublish = false;
  }

  private async assertSupported(capability: NatsCapability, usage: string): Promise<void> {
    (await this.connection.getCapabilities()).assert(capability, usage);
  }

  private schedules(): ScheduleClient {
    this.scheduleClient ??= new ScheduleClient(this.connection, this.codec, this.subjects);

    return this.scheduleClient;
  }

  /** Resolve a user pattern to a fully-qualified NATS subject of the target. */
  private buildEventSubject(pattern: string): string {
    if (pattern.startsWith(PatternPrefix.Broadcast)) {
      return this.subjects.subject(
        StreamKind.Broadcast,
        pattern.slice(PatternPrefix.Broadcast.length),
      );
    }

    if (pattern.startsWith(PatternPrefix.Ordered)) {
      return this.subjects.subject(StreamKind.Ordered, pattern.slice(PatternPrefix.Ordered.length));
    }

    return this.subjects.subject(StreamKind.Event, pattern);
  }

  /** Build NATS headers merging custom headers with transport headers. */
  private buildHeaders(
    customHeaders: Map<string, string> | null,
    transport: TransportHeaderOptions,
  ): MsgHdrs {
    const hdrs = natsHeaders();

    hdrs.set(JetstreamHeader.Subject, transport.subject);
    hdrs.set(JetstreamHeader.CallerName, this.callerName);

    if (transport.correlationId) {
      hdrs.set(JetstreamHeader.CorrelationId, transport.correlationId);
    }

    if (transport.replyTo) {
      hdrs.set(JetstreamHeader.ReplyTo, transport.replyTo);
    }

    // Reserved headers were already validated by extractRecordData.
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
      // Checked here rather than in the constructor: a record built directly,
      // by another copy of the package, or whose map was changed afterwards
      // must not override routing headers or reach NATS with control headers.
      for (const key of rawData.headers.keys()) assertHeaderAllowed(key);

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
   * The holder lives in the same stream as the target but under the `_sch`
   * namespace no consumer filter matches; the server publishes it to the
   * target subject when the schedule fires. The unique per-message suffix
   * exists because the server stores schedules as rollup messages, one
   * active schedule per subject (ADR-51): without it, concurrent schedules
   * of the same pattern would silently replace each other.
   */
  private buildScheduleSubject(eventSubject: string): string {
    const base = this.subjects.scheduleSubjectBase(eventSubject);

    return `${base}.${nuid.next()}`;
  }
}
