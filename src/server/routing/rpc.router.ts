import { Logger } from '@nestjs/common';
import { MessageHandler } from '@nestjs/microservices';
import { headers, type NatsConnection } from '@nats-io/transport-node';
import type { JsMsg } from '@nats-io/jetstream';
import { Subscription } from 'rxjs';

import { ConnectionProvider } from '../../connection';
import { RpcContext } from '../../context';
import { EventBus } from '../../hooks';
import { MessageKind, StreamKind, TransportEvent } from '../../interfaces';
import type {
  Codec,
  HandlerStatus,
  JetstreamModuleOptions,
  RpcRouterOptions,
} from '../../interfaces';
import { DEFAULT_JETSTREAM_RPC_TIMEOUT, JetstreamHeader } from '../../jetstream.constants';
import {
  ConsumeKind,
  deriveOtelAttrs,
  resolveOtelOptions,
  withConsumeSpan,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../../otel';
import {
  isPromiseLike,
  resolveAckExtensionInterval,
  serializeError,
  settleQuietly,
  startAckExtensionTimer,
  unwrapResult,
} from '../../utils';

import { MessageProvider } from '../infrastructure';
import { ConcurrencyGate } from './concurrency-gate';
import { PatternRegistry } from './pattern-registry';
import type { ParkTimerFn } from './routing.types';

/**
 * Routing shape resolved for one incoming RPC command: the selected handler,
 * the decoded payload, and the reply coordinates read from the message headers.
 * {@link RpcRouter} resolution helpers return `null` when the message cannot be
 * routed and has already been settled.
 */
interface ResolvedCommand {
  readonly handler: MessageHandler;
  readonly data: unknown;
  readonly replyTo: string;
  readonly correlationId: string;
}

/**
 * Routes RPC command messages in JetStream mode.
 *
 * Delivery semantics:
 * - Handler must complete within timeout (default: 3 min)
 * - Success -> ack -> publish response to ReplyTo (publish failure does not affect ack)
 * - Handler error -> publish error to ReplyTo -> term (no redelivery)
 * - Timeout -> no response -> term
 * - No handler / decode error -> term immediately
 *
 * Nak is never used for RPC; it would risk duplicate side effects.
 */
export class RpcRouter {
  private readonly logger = new Logger('Jetstream:RpcRouter');
  private readonly timeout: number;
  private readonly concurrency: number | undefined;
  private resolvedAckExtensionInterval: number | null | undefined;
  private subscription: Subscription | null = null;
  private cachedNc: NatsConnection | null = null;

  private readonly otel: ResolvedOtelOptions;
  private readonly serviceName: string;
  private readonly serverEndpoint: ServerEndpoint | null;

  public constructor(
    private readonly messageProvider: MessageProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly connection: ConnectionProvider,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
    private readonly rpcOptions?: RpcRouterOptions,
    private readonly ackWaitMap?: Map<StreamKind, number>,
    options?: JetstreamModuleOptions,
  ) {
    this.timeout = rpcOptions?.timeout ?? DEFAULT_JETSTREAM_RPC_TIMEOUT;
    this.concurrency = rpcOptions?.concurrency;
    if (options) {
      const derived = deriveOtelAttrs(options);

      this.otel = derived.otel;
      this.serviceName = derived.serviceName;
      this.serverEndpoint = derived.serverEndpoint;
    } else {
      // Unit-test instantiation without options: disable OTel entirely
      // so span helpers short-circuit on `config.enabled` before touching
      // the placeholder values. See EventRouter for the same pattern.
      this.otel = resolveOtelOptions({ enabled: false });
      this.serviceName = '';
      this.serverEndpoint = null;
    }
  }

  /** Lazily resolve the ack extension interval (needs ackWaitMap populated at runtime). */
  private get ackExtensionInterval(): number | null {
    if (this.resolvedAckExtensionInterval !== undefined) return this.resolvedAckExtensionInterval;
    this.resolvedAckExtensionInterval = resolveAckExtensionInterval(
      this.rpcOptions?.ackExtension,
      this.ackWaitMap?.get(StreamKind.Command),
    );
    return this.resolvedAckExtensionInterval;
  }

  /** Start routing command messages to handlers. */
  public async start(): Promise<void> {
    this.cachedNc = await this.connection.getConnection();

    const nc = this.cachedNc;
    const patternRegistry = this.patternRegistry;
    const codec = this.codec;
    const eventBus = this.eventBus;
    const logger = this.logger;
    const timeout = this.timeout;
    const ackExtensionInterval = this.ackExtensionInterval;
    const hasAckExtension = ackExtensionInterval !== null && ackExtensionInterval > 0;
    const maxActive = this.concurrency ?? Number.POSITIVE_INFINITY;
    const otel = this.otel;
    const serviceName = this.serviceName;
    const serverEndpoint = this.serverEndpoint;

    const emitRpcTimeout = (subject: string, correlationId: string): void => {
      eventBus.emit(TransportEvent.RpcTimeout, subject, correlationId);
    };

    // See EventRouter.reportHandlerCompleted for the rationale on declared
    // pattern + per-emit hasHook check.
    const reportHandlerCompleted = (msg: JsMsg, startedAt: number, status: HandlerStatus): void => {
      if (!eventBus.hasHook(TransportEvent.HandlerCompleted)) return;
      const declared = patternRegistry.resolveDeclared(msg.subject);
      const pattern = declared?.pattern ?? msg.subject;
      const declaredKind = declared?.kind ?? StreamKind.Command;

      eventBus.emit(
        TransportEvent.HandlerCompleted,
        pattern,
        declaredKind,
        performance.now() - startedAt,
        status,
      );
    };

    const publishReply = (replyTo: string, correlationId: string, payload: unknown): void => {
      try {
        const hdrs = headers();

        hdrs.set(JetstreamHeader.CorrelationId, correlationId);
        nc.publish(replyTo, codec.encode(payload), { headers: hdrs });
      } catch (publishErr) {
        logger.error(`Failed to publish RPC response`, publishErr);
      }
    };

    const publishErrorReply = (
      replyTo: string,
      correlationId: string,
      subject: string,
      err: unknown,
    ): void => {
      try {
        const hdrs = headers();

        hdrs.set(JetstreamHeader.CorrelationId, correlationId);
        hdrs.set(JetstreamHeader.Error, 'true');
        nc.publish(replyTo, codec.encode(serializeError(err)), { headers: hdrs });
      } catch (encodeErr) {
        logger.error(`Failed to encode RPC error for ${subject}`, encodeErr);
      }
    };

    const resolveCommand = (msg: JsMsg): ResolvedCommand | null => {
      const subject = msg.subject;

      try {
        const handler = patternRegistry.getHandler(subject);

        if (!handler) {
          msg.term(`No handler for RPC: ${subject}`);
          logger.error(`No handler for RPC subject: ${subject}`);

          return null;
        }

        const msgHeaders = msg.headers;
        const replyTo = msgHeaders?.get(JetstreamHeader.ReplyTo);
        const correlationId = msgHeaders?.get(JetstreamHeader.CorrelationId);

        if (!replyTo || !correlationId) {
          msg.term('Missing required headers (reply-to or correlation-id)');
          logger.error(`Missing headers for RPC: ${subject}`);

          return null;
        }

        let data: unknown;

        try {
          data = codec.decode(msg.data);
        } catch (err) {
          msg.term('Decode error');
          logger.error(`Decode error for RPC ${subject}:`, err);

          return null;
        }

        eventBus.emitMessageRouted(subject, MessageKind.Rpc);

        return { handler, data, replyTo, correlationId };
      } catch (err) {
        logger.error('Unexpected error in RPC router', err);
        // Terminate the command so NATS does not redeliver into the same
        // synchronous failure forever. term() itself may throw when the
        // connection is degraded; swallow that to keep the subscription alive.
        try {
          msg.term('Unexpected router error');
        } catch (termErr) {
          logger.error(`Failed to terminate RPC message ${subject}:`, termErr);
        }

        return null;
      }
    };

    /**
     * Run the full RPC pipeline for one command.
     *
     * Returns `undefined` when the handler completed synchronously and a
     * Promise when we are still awaiting user work, so the concurrency
     * limiter can skip `.finally()` allocation on the sync path.
     *
     * The deadline `setTimeout` is only armed on the async branch: sync
     * handlers cannot miss the deadline they return inside, so registering
     * a timer just to clear it microseconds later is wasted work.
     */
    const handleSafe = (msg: JsMsg): Promise<void> | undefined => {
      const resolved = resolveCommand(msg);

      if (resolved === null) return undefined;

      const { handler, data, replyTo, correlationId } = resolved;
      const subject = msg.subject;
      const ctx = new RpcContext([msg]);
      const stopAckExtension = hasAckExtension
        ? startAckExtensionTimer(msg, ackExtensionInterval)
        : null;
      const startedAt = performance.now();

      const reportHandlerError = (err: unknown): void => {
        eventBus.emit(
          TransportEvent.Error,
          err instanceof Error ? err : new Error(String(err)),
          `rpc-handler:${subject}`,
        );
        publishErrorReply(replyTo, correlationId, subject, err);
        settleQuietly(logger, `Failed to term ${subject}:`, () => {
          msg.term(`Handler error: ${subject}`);
        });
      };

      // Abort wire that the handler-deadline timer uses to close the
      // CONSUMER span early. Handlers that hang past the deadline would
      // otherwise keep their span open indefinitely.
      const abortController = new AbortController();
      let pending: unknown;

      try {
        pending = withConsumeSpan(
          {
            subject,
            msg,
            info: msg.info,
            kind: ConsumeKind.Rpc,
            payloadBytes: msg.data.length,
            handlerMetadata: { pattern: subject },
            serviceName,
            endpoint: serverEndpoint,
          },
          otel,
          () => unwrapResult(handler(data, ctx)),
          { signal: abortController.signal, timeoutLabel: 'rpc.handler.timeout' },
        );
      } catch (err) {
        if (stopAckExtension !== null) stopAckExtension();
        reportHandlerError(err);
        reportHandlerCompleted(msg, startedAt, 'error');

        return undefined;
      }

      if (!isPromiseLike(pending)) {
        if (stopAckExtension !== null) stopAckExtension();
        settleQuietly(logger, `Failed to ack ${subject}:`, () => {
          msg.ack();
        });
        publishReply(replyTo, correlationId, pending);
        reportHandlerCompleted(msg, startedAt, 'success');

        return undefined;
      }

      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (stopAckExtension !== null) stopAckExtension();
        // Close the CONSUMER span early via the abort signal; the handler's
        // eventual resolution is ignored (span is idempotent after first finish).
        abortController.abort();
        // RpcTimeout hook is the canonical signal here, no separate log.
        emitRpcTimeout(subject, correlationId);
        // Bare timer callback: an unguarded term throw would be an uncaught exception.
        settleQuietly(logger, `Failed to term ${subject}:`, () => {
          msg.term('Handler timeout');
        });
        // Transport outcome is terminated; the handler's eventual resolution
        // is irrelevant once we've replied with timeout.
        reportHandlerCompleted(msg, startedAt, 'terminated');
      }, timeout);

      return (pending as Promise<unknown>).then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          if (stopAckExtension !== null) stopAckExtension();
          settleQuietly(logger, `Failed to ack ${subject}:`, () => {
            msg.ack();
          });
          publishReply(replyTo, correlationId, result);
          reportHandlerCompleted(msg, startedAt, 'success');
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          if (stopAckExtension !== null) stopAckExtension();
          // Handler error is surfaced via the OTel CONSUMER span (recordException
          // on unexpected errors, OK + attributes on classified-expected errors)
          // and via the transport-error reply. No separate log.
          reportHandlerError(err);
          reportHandlerCompleted(msg, startedAt, 'error');
        },
      );
    };

    const parkTimer: ParkTimerFn | null = hasAckExtension
      ? (msg): (() => void) | null => startAckExtensionTimer(msg, ackExtensionInterval)
      : null;
    const gate = new ConcurrencyGate(maxActive, handleSafe, parkTimer, logger, 'RPC');

    this.subscription = this.messageProvider.commands$.subscribe({
      next: (msg: JsMsg): void => {
        gate.push(msg);
      },
      error: (err: unknown): void => {
        logger.error('Stream error in RPC router', err);
      },
    });

    this.subscription.add(() => {
      gate.dispose();
    });
  }

  /** Stop routing and unsubscribe. */
  public destroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }
}
