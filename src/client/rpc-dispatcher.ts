import type { WritePacket } from '@nestjs/microservices';

import { nuid } from '@nats-io/nuid';
import { TimeoutError, type NatsConnection } from '@nats-io/transport-node';

import { context } from '@opentelemetry/api';

import { JetstreamRpcError, RpcErrorReason, toPublishError } from '../errors';
import { StreamKind, TransportEvent } from '../interfaces';
import type { PublishStatus, RpcOutcomeStatus } from '../interfaces';
import { JetstreamHeader } from '../jetstream.constants';
import {
  beginRpcClientSpan,
  RPC_TIMEOUT_MESSAGE,
  RpcOutcomeKind,
  type RpcClientSpanHandle,
  type RpcOutcome,
} from '../otel';
import type {
  JetStreamRpcRequest,
  RpcDispatcherHost,
  RpcReplyCallback,
  RpcRequest,
} from './client.types';

/** One round-trip in flight: what settling it reports and whom it answers. */
interface PendingRpc {
  readonly span: RpcClientSpanHandle;
  readonly declaredPattern: string;
  readonly startedAt: number;
  readonly callback: RpcReplyCallback;
}

interface RpcSettlement {
  readonly outcome: RpcOutcome;
  /** Runs after the span ends and before the hooks; emits the timeout or error event. */
  announce?(): void;
  /** Omitted when the publish leg was already reported. */
  readonly published?: PublishStatus;
  readonly status: RpcOutcomeStatus;
  readonly packet: WritePacket;
}

/** Sends `client.send()` requests in Core or JetStream RPC mode and settles each exactly once. */
export class RpcDispatcher {
  public constructor(private readonly host: RpcDispatcherHost) {}

  /** Core mode: nc.request() with timeout. */
  public async publishCore(request: RpcRequest, callback: RpcReplyCallback): Promise<void> {
    const { subject, declaredPattern } = request;
    const host = this.host;
    const effectiveTimeout = request.timeout ?? host.defaultTimeout;
    const hdrs = host.buildHeaders(request.headers, { subject });
    const encoded = host.codec.encode(request.data);
    const span = beginRpcClientSpan(
      {
        subject,
        payloadBytes: encoded.length,
        payload: encoded,
        headers: hdrs,
        serviceName: host.callerName,
        endpoint: host.serverEndpoint,
      },
      host.otel,
    );
    const call: PendingRpc = { span, declaredPattern, startedAt: performance.now(), callback };

    try {
      const nc = host.isReady() ? (host.connection.unwrap as NatsConnection) : await host.connect();

      // Run the round-trip under the CLIENT span's context so any handler
      // / interceptor spans triggered by the NATS reply decode nest under
      // this span instead of the pre-existing ambient one.
      const response = await context.with(span.activeContext, () =>
        nc.request(subject, encoded, {
          timeout: effectiveTimeout,
          headers: hdrs,
        }),
      );

      const decoded = host.codec.decode(response.data);

      // In Core RPC the publish leg is implicit inside nc.request(): any
      // response (or pre-response transport error) means the publish ran, so
      // Published always carries success here. RpcCompleted captures the
      // round-trip outcome separately.
      if (response.headers?.get(JetstreamHeader.Error)) {
        this.settle(call, {
          outcome: { kind: RpcOutcomeKind.ReplyError, replyPayload: decoded },
          published: 'success',
          status: 'error',
          packet: { err: decoded, response: null, isDisposed: true },
        });
      } else {
        this.settle(call, {
          outcome: { kind: RpcOutcomeKind.Ok, reply: decoded },
          published: 'success',
          status: 'success',
          packet: { err: null, response: decoded, isDisposed: true },
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      const packet = { err: error, response: null, isDisposed: true };

      if (error instanceof TimeoutError) {
        this.settle(call, {
          outcome: { kind: RpcOutcomeKind.Timeout },
          announce: () => {
            host.eventBus.emit(TransportEvent.RpcTimeout, subject, '');
          },
          published: 'success',
          status: 'timeout',
          packet,
        });
      } else {
        this.settle(call, {
          outcome: { kind: RpcOutcomeKind.Error, error },
          // Error hook + OTel CLIENT span are the canonical signals; no separate log.
          announce: () => {
            host.eventBus.emit(TransportEvent.Error, error, 'client-rpc');
          },
          published: 'error',
          status: 'error',
          packet,
        });
      }
    }
  }

  /** JetStream mode: publish to stream + wait for inbox response. */
  public async publishJetStream(
    request: JetStreamRpcRequest,
    callback: RpcReplyCallback,
  ): Promise<void> {
    const { subject, correlationId, messageId, declaredPattern } = request;
    const host = this.host;
    const inbox = host.inbox;
    const effectiveTimeout = request.timeout ?? host.defaultTimeout;
    const hdrs = host.buildHeaders(request.headers, {
      subject,
      correlationId,
      replyTo: inbox.address ?? '',
    });
    const encoded = host.codec.encode(request.data);
    const span = beginRpcClientSpan(
      {
        subject,
        correlationId,
        payloadBytes: encoded.length,
        payload: encoded,
        messageId,
        headers: hdrs,
        serviceName: host.callerName,
        endpoint: host.serverEndpoint,
      },
      host.otel,
    );
    const call: PendingRpc = { span, declaredPattern, startedAt: performance.now(), callback };

    const settleRoundTrip: RpcReplyCallback = (packet: WritePacket) => {
      // Translate the inbox-callback WritePacket into an RPC outcome. A native
      // `Error` instance reaches this path from `rejectPendingRpcs` (disconnect,
      // client close) or a decode failure in `routeInboxReply`; both are
      // transport-level failures. Any other non-empty `err` is a decoded
      // business error envelope returned by the server.
      if (packet.err) {
        this.settle(call, {
          outcome:
            packet.err instanceof Error
              ? { kind: RpcOutcomeKind.Error, error: packet.err }
              : { kind: RpcOutcomeKind.ReplyError, replyPayload: packet.err },
          status: 'error',
          packet,
        });
      } else {
        this.settle(call, {
          outcome: { kind: RpcOutcomeKind.Ok, reply: packet.response },
          status: 'success',
          packet,
        });
      }
    };

    inbox.register(correlationId, settleRoundTrip);

    // Arm the deadline BEFORE awaiting connect() so a permanent NATS outage
    // (where `maxReconnectAttempts: -1` keeps connect() pending forever) still
    // settles the span, the pending-message entry, and the caller's
    // subscription instead of leaking them for the life of the process.
    // `effectiveTimeout` bounds connect and RPC together, not RPC alone.
    inbox.armTimeout(correlationId, effectiveTimeout, () => {
      this.settle(call, {
        outcome: { kind: RpcOutcomeKind.Timeout },
        // RpcTimeout hook + OTel CLIENT span are the canonical signals; no separate log.
        announce: () => {
          host.eventBus.emit(TransportEvent.RpcTimeout, subject, correlationId);
        },
        status: 'timeout',
        packet: {
          err: new JetstreamRpcError(RpcErrorReason.Timeout, RPC_TIMEOUT_MESSAGE),
          response: null,
          isDisposed: true,
        },
      });
    });

    try {
      if (!host.isReady()) await host.connect();

      // Bail out if cleaned up during connect (timeout fired, or consumer unsubscribed)
      if (!inbox.has(correlationId)) return;

      if (!inbox.address) {
        inbox.discard(correlationId);
        this.settle(call, {
          outcome: { kind: RpcOutcomeKind.Error, error: new Error('Inbox not initialized') },
          published: 'error',
          status: 'error',
          packet: {
            err: new JetstreamRpcError(
              RpcErrorReason.InboxNotReady,
              'Inbox not initialized; JetStream RPC mode requires a connected inbox',
            ),
            response: null,
            isDisposed: true,
          },
        });

        return;
      }

      // Run the publish under the CLIENT span's context so any handler /
      // interceptor spans around the publish itself nest under the CLIENT
      // round-trip span rather than the ambient context.
      const ack = await context.with(span.activeContext, () =>
        host.connection.getJetStreamClient().publish(subject, encoded, {
          headers: hdrs,
          msgID: messageId ?? nuid.next(),
        }),
      );

      if (ack.duplicate) {
        // The reply belongs to the original (deduped) request; fail fast instead of waiting out the timeout.
        throw new JetstreamRpcError(
          RpcErrorReason.DuplicatePublish,
          `Duplicate RPC publish for ${subject}: the messageId was already used within the ` +
            'stream dedup window, so the reply belongs to the original request',
        );
      }

      // Publish leg succeeded; RpcCompleted fires from the inbox reply or
      // the timeout branch once the round-trip settles.
      host.reporter.published(declaredPattern, StreamKind.Command, call.startedAt, 'success');
    } catch (err) {
      if (!inbox.discard(correlationId)) return;

      const published = toPublishError(err);
      const error = published instanceof Error ? published : new Error('Unknown error');

      this.settle(call, {
        outcome: { kind: RpcOutcomeKind.Error, error },
        announce: () => {
          host.eventBus.emit(TransportEvent.Error, error, `jetstream-rpc-publish:${subject}`);
        },
        published: 'error',
        status: 'error',
        packet: { err: error, response: null, isDisposed: true },
      });
    }
  }

  private settle(call: PendingRpc, settlement: RpcSettlement): void {
    call.span.finish(settlement.outcome);
    settlement.announce?.();

    if (settlement.published) {
      this.host.reporter.published(
        call.declaredPattern,
        StreamKind.Command,
        call.startedAt,
        settlement.published,
      );
    }

    this.host.reporter.rpcCompleted(call.declaredPattern, call.startedAt, settlement.status);
    call.callback(settlement.packet);
  }
}
