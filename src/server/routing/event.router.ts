import { Logger } from '@nestjs/common';
import { MessageHandler } from '@nestjs/microservices';
import type { JsMsg } from '@nats-io/jetstream';
import { Observable, Subscription } from 'rxjs';

import { RpcContext } from '../../context';
import { EventBus } from '../../hooks';
import { MessageKind, StreamKind, TransportEvent } from '../../interfaces';
import { ConnectionProvider } from '../../connection';
import { headers as natsHeaders, type MsgHdrs } from '@nats-io/transport-node';

import type {
  Codec,
  DeadLetterConfig,
  DeadLetterInfo,
  EventProcessingConfig,
  HandlerStatus,
  JetstreamModuleOptions,
} from '../../interfaces';
import {
  isPromiseLike,
  resolveAckExtensionInterval,
  settleQuietly,
  startAckExtensionTimer,
  unwrapResult,
} from '../../utils';

import { MessageProvider } from '../infrastructure';
import { PatternRegistry } from './pattern-registry';
import {
  dlqStreamName,
  JetstreamDlqHeader,
  NATS_CONTROL_HEADER_PREFIX,
} from '../../jetstream.constants';
import {
  ConsumeKind,
  deriveOtelAttrs,
  resolveOtelOptions,
  withConsumeSpan,
  withDeadLetterSpan,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../../otel';

/** Narrow consume-kind tag emitted by the event router (no `Rpc` here). */
type EventConsumeKind = Exclude<ConsumeKind, ConsumeKind.Rpc>;

/** How many times a dead letter is published to the DLQ stream before falling back. */
const DLQ_PUBLISH_ATTEMPTS = 3;

/**
 * Resolved routing shape for one incoming event/broadcast/ordered message —
 * the handler selected for dispatch and the decoded payload. `null` is
 * returned by {@link EventRouter} resolution helpers when the message cannot
 * be routed (no handler, decode error, or pre-dispatch failure).
 */
interface ResolvedEvent {
  readonly handler: MessageHandler;
  readonly data: unknown;
}

const eventConsumeKindFor = (kind: StreamKind): EventConsumeKind => {
  if (kind === StreamKind.Broadcast) return ConsumeKind.Broadcast;
  if (kind === StreamKind.Ordered) return ConsumeKind.Ordered;

  return ConsumeKind.Event;
};

export class EventRouter {
  private readonly logger = new Logger('Jetstream:EventRouter');
  private readonly subscriptions: Subscription[] = [];

  private readonly otel: ResolvedOtelOptions;
  private readonly serviceName: string;
  private readonly serverEndpoint: ServerEndpoint | null;

  public constructor(
    private readonly messageProvider: MessageProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
    private readonly deadLetterConfig?: DeadLetterConfig,
    private readonly processingConfig?: EventProcessingConfig,
    private readonly ackWaitMap?: Map<StreamKind, number>,
    private readonly connection?: ConnectionProvider,
    private readonly options?: JetstreamModuleOptions,
  ) {
    if (options) {
      const derived = deriveOtelAttrs(options);

      this.otel = derived.otel;
      this.serviceName = derived.serviceName;
      this.serverEndpoint = derived.serverEndpoint;
    } else {
      // Unit-test instantiation without options — disable OTel entirely
      // so span helpers short-circuit on the first line (`config.enabled`)
      // and never read the placeholder values below.
      this.otel = resolveOtelOptions({ enabled: false });
      this.serviceName = '';
      this.serverEndpoint = null;
    }
  }

  /**
   * Update the max_deliver thresholds from actual NATS consumer configs.
   * Called after consumers are ensured so the DLQ map reflects reality.
   */
  public updateMaxDeliverMap(consumerMaxDelivers: Map<string, number>): void {
    if (!this.deadLetterConfig) return;
    this.deadLetterConfig.maxDeliverByStream = consumerMaxDelivers;
  }

  /** Start routing event, broadcast, and ordered messages to handlers. */
  public start(): void {
    this.subscribeToStream(this.messageProvider.events$, StreamKind.Event);
    this.subscribeToStream(this.messageProvider.broadcasts$, StreamKind.Broadcast);

    if (this.patternRegistry.hasOrderedHandlers()) {
      this.subscribeToStream(this.messageProvider.ordered$, StreamKind.Ordered);
    }
  }

  /** Stop routing and unsubscribe from all streams. */
  public destroy(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }

    this.subscriptions.length = 0;
  }

  /** Subscribe to a message stream and route each message to its handler. */
  private subscribeToStream(stream$: Observable<JsMsg>, kind: StreamKind): void {
    const isOrdered = kind === StreamKind.Ordered;

    const patternRegistry = this.patternRegistry;
    const codec = this.codec;
    const eventBus = this.eventBus;
    const logger = this.logger;
    const deadLetterConfig = this.deadLetterConfig;
    const otel = this.otel;
    const serviceName = this.serviceName;
    const serverEndpoint = this.serverEndpoint;
    const spanKind: EventConsumeKind = eventConsumeKindFor(kind);

    const ackExtensionInterval = isOrdered
      ? null
      : resolveAckExtensionInterval(this.getAckExtensionConfig(kind), this.ackWaitMap?.get(kind));
    const hasAckExtension = ackExtensionInterval !== null && ackExtensionInterval > 0;
    const concurrency = this.getConcurrency(kind);
    // Snapshot the config object, not the Map — updateMaxDeliverMap() can
    // replace maxDeliverByStream wholesale after consumers are ensured.
    const hasDlqCheck = deadLetterConfig !== undefined;

    // Use the declared pattern (not the wire subject) so cardinality stays
    // bounded. hasHook is checked per-emit, not snapshotted, so late
    // subscribers (e.g. JetstreamMetricsService bootstrapping after this
    // router starts) still receive events.
    const reportHandlerCompleted = (msg: JsMsg, startedAt: number, status: HandlerStatus): void => {
      if (!eventBus.hasHook(TransportEvent.HandlerCompleted)) return;
      const declared = patternRegistry.resolveDeclared(msg.subject);
      const pattern = declared?.pattern ?? msg.subject;
      const declaredKind = declared?.kind ?? kind;
      const durationMs = performance.now() - startedAt;

      eventBus.emit(TransportEvent.HandlerCompleted, pattern, declaredKind, durationMs, status);
    };

    const isDeadLetter = (msg: JsMsg): boolean => {
      if (!hasDlqCheck) return false;
      // updateMaxDeliverMap() populates maxDeliverByStream after consumers are
      // ensured. Optional chaining guards the brief startup window before it
      // is assigned — the interface types it as always-present but the runtime
      // lifecycle allows a brief undefined state.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime lifecycle guard
      const maxDeliver = deadLetterConfig.maxDeliverByStream?.get(msg.info.stream);

      if (maxDeliver === undefined || maxDeliver <= 0) return false;

      return msg.info.deliveryCount >= maxDeliver;
    };

    const handleDeadLetter = hasDlqCheck
      ? (msg: JsMsg, data: unknown, err: unknown): Promise<void> =>
          this.handleDeadLetter(msg, data, err)
      : null;

    /**
     * Settle a message whose handler completed without throwing.
     *
     * Returns a Promise only when a `retry()` on the final permitted delivery
     * escalates to dead-letter handling — a nak at that point would strand the
     * message, since the server never redelivers past `max_deliver`.
     */
    const settleSuccess = (
      msg: JsMsg,
      ctx: RpcContext,
      data: unknown,
    ): Promise<void> | undefined => {
      if (ctx.shouldTerminate) {
        settleQuietly(logger, `Failed to term ${msg.subject}:`, () => {
          msg.term(ctx.terminateReason);
        });

        return undefined;
      }

      if (ctx.shouldRetry) {
        if (handleDeadLetter !== null && isDeadLetter(msg)) {
          return handleDeadLetter(
            msg,
            data,
            new Error('Retry requested on the final delivery attempt'),
          );
        }

        settleQuietly(logger, `Failed to nak ${msg.subject}:`, () => {
          msg.nak(ctx.retryDelay);
        });

        return undefined;
      }

      settleQuietly(logger, `Failed to ack ${msg.subject}:`, () => {
        msg.ack();
      });

      return undefined;
    };

    const settleFailure = async (msg: JsMsg, data: unknown, err: unknown): Promise<void> => {
      if (handleDeadLetter !== null && isDeadLetter(msg)) {
        await handleDeadLetter(msg, data, err);

        return;
      }

      settleQuietly(logger, `Failed to nak ${msg.subject}:`, () => {
        msg.nak();
      });
    };

    /**
     * Capture a message that can never be routed (no handler, undecodable
     * payload). Redelivery cannot fix these, so they go straight to
     * dead-letter handling regardless of delivery count. On a workqueue
     * stream a plain term() would delete the payload permanently.
     */
    const captureUnroutable = (
      capture: NonNullable<typeof handleDeadLetter>,
      msg: JsMsg,
      err: Error,
    ): Promise<void> => {
      let data: unknown;

      try {
        data = codec.decode(msg.data);
      } catch {
        data = undefined;
      }

      return capture(msg, data, err).catch((captureErr: unknown) => {
        logger.error(`Dead-letter capture failed for unroutable ${msg.subject}:`, captureErr);
      });
    };

    /**
     * Resolve the handler and decode payload for one event.
     *
     * Returns `null` when the message cannot be routed and was settled
     * synchronously, a Promise when an unroutable message is being captured
     * by dead-letter handling, and a {@link ResolvedEvent} otherwise.
     */
    const resolveEvent = (msg: JsMsg): ResolvedEvent | Promise<void> | null => {
      const subject = msg.subject;

      try {
        const handler = patternRegistry.getHandler(subject);

        if (!handler) {
          logger.error(`No handler for subject: ${subject}`);

          if (handleDeadLetter !== null) {
            return captureUnroutable(
              handleDeadLetter,
              msg,
              new Error(`No handler for event: ${subject}`),
            );
          }

          msg.term(`No handler for event: ${subject}`);

          return null;
        }

        let data: unknown;

        try {
          data = codec.decode(msg.data);
        } catch (err) {
          logger.error(`Decode error for ${subject}:`, err);

          if (handleDeadLetter !== null) {
            return captureUnroutable(
              handleDeadLetter,
              msg,
              new Error(`Decode error: ${err instanceof Error ? err.message : String(err)}`),
            );
          }

          msg.term('Decode error');

          return null;
        }

        eventBus.emitMessageRouted(subject, MessageKind.Event);

        return { handler, data };
      } catch (err) {
        logger.error(`Unexpected error in ${kind} event router`, err);
        // Terminate the message so NATS does not redeliver into the same
        // synchronous failure forever. term() itself may throw when the
        // connection is degraded — swallow that to keep the subscription alive.
        try {
          msg.term('Unexpected router error');
        } catch (termErr) {
          logger.error(`Failed to terminate message ${subject}:`, termErr);
        }

        return null;
      }
    };

    // Order mirrors settleSuccess: explicit terminate() wins over retry().
    const statusForContext = (ctx: RpcContext): HandlerStatus => {
      if (ctx.shouldTerminate) return 'terminated';
      if (ctx.shouldRetry) return 'retried';

      return 'success';
    };

    /**
     * Run the full event-routing pipeline for one message.
     *
     * Returns `undefined` when the whole flow completed synchronously
     * (sync handler, no awaitable settlement) and a Promise otherwise, so
     * the concurrency limiter can skip the `.finally()` allocation on the
     * sync path. The sync branch inlines settlement to avoid per-message
     * closures that would cost more heap than the Promise they replace.
     */
    const handleSafe = (msg: JsMsg): Promise<void> | undefined => {
      const resolved = resolveEvent(msg);

      if (resolved === null) return undefined;
      if (isPromiseLike(resolved)) return resolved as Promise<void>;

      const { handler, data } = resolved;
      const ctx = new RpcContext([msg]);
      const stopAckExtension = hasAckExtension
        ? startAckExtensionTimer(msg, ackExtensionInterval)
        : null;
      const startedAt = performance.now();

      let pending: unknown;

      try {
        pending = withConsumeSpan(
          {
            subject: msg.subject,
            msg,
            info: msg.info,
            kind: spanKind,
            payloadBytes: msg.data.length,
            handlerMetadata: { pattern: msg.subject },
            serviceName,
            endpoint: serverEndpoint,
          },
          otel,
          () => unwrapResult(handler(data, ctx)),
        );
      } catch (err) {
        eventBus.emit(
          TransportEvent.Error,
          err instanceof Error ? err : new Error(String(err)),
          `${kind}-handler:${msg.subject}`,
        );

        reportHandlerCompleted(msg, startedAt, 'error');

        // Keep ack extension alive across settleFailure() — it may route
        // through handleDeadLetter → publishToDlq whose JetStream publish
        // can take longer than the consumer's `ack_wait`. Stopping the
        // extension early would let NATS redeliver the message mid-DLQ
        // publish and double-fire onDeadLetter. Mirrors the async branch
        // below.
        return settleFailure(msg, data, err).finally(() => {
          if (stopAckExtension !== null) stopAckExtension();
        });
      }

      if (!isPromiseLike(pending)) {
        const settled = settleSuccess(msg, ctx, data);

        reportHandlerCompleted(msg, startedAt, statusForContext(ctx));

        if (settled === undefined) {
          if (stopAckExtension !== null) stopAckExtension();

          return undefined;
        }

        // Same ack-extension reasoning as the failure path: the dead-letter
        // publish may outlast ack_wait.
        return settled.finally(() => {
          if (stopAckExtension !== null) stopAckExtension();
        });
      }

      return (pending as Promise<unknown>).then(
        async () => {
          try {
            await settleSuccess(msg, ctx, data);
            reportHandlerCompleted(msg, startedAt, statusForContext(ctx));
          } finally {
            if (stopAckExtension !== null) stopAckExtension();
          }
        },
        async (err: unknown) => {
          eventBus.emit(
            TransportEvent.Error,
            err instanceof Error ? err : new Error(String(err)),
            `${kind}-handler:${msg.subject}`,
          );
          reportHandlerCompleted(msg, startedAt, 'error');
          try {
            await settleFailure(msg, data, err);
          } finally {
            if (stopAckExtension !== null) stopAckExtension();
          }
        },
      );
    };

    const handleOrderedSafe = (msg: JsMsg): Promise<void> | undefined => {
      const subject = msg.subject;
      let handler: MessageHandler | null;
      let data: unknown;

      try {
        handler = patternRegistry.getHandler(subject);

        if (!handler) {
          logger.error(`No handler for subject: ${subject}`);

          return undefined;
        }

        try {
          data = codec.decode(msg.data);
        } catch (err) {
          logger.error(`Decode error for ${subject}:`, err);

          return undefined;
        }

        eventBus.emitMessageRouted(subject, MessageKind.Event);
      } catch (err) {
        logger.error(`Ordered handler error (${subject}):`, err);

        return undefined;
      }

      const ctx = new RpcContext([msg]);

      const warnIfSettlementAttempted = (): void => {
        if (ctx.shouldRetry || ctx.shouldTerminate) {
          logger.warn(
            `retry()/terminate() ignored for ordered message ${subject} — ordered consumers auto-acknowledge`,
          );
        }
      };

      const startedAt = performance.now();
      let pending: unknown;

      try {
        pending = withConsumeSpan(
          {
            subject: msg.subject,
            msg,
            info: msg.info,
            kind: spanKind,
            payloadBytes: msg.data.length,
            handlerMetadata: { pattern: msg.subject },
            serviceName,
            endpoint: serverEndpoint,
          },
          otel,
          () => unwrapResult(handler(data, ctx)),
        );
      } catch (err) {
        logger.error(`Ordered handler error (${subject}):`, err);
        reportHandlerCompleted(msg, startedAt, 'error');

        return undefined;
      }

      if (!isPromiseLike(pending)) {
        warnIfSettlementAttempted();
        reportHandlerCompleted(msg, startedAt, 'success');

        return undefined;
      }

      return (pending as Promise<unknown>).then(
        () => {
          warnIfSettlementAttempted();
          reportHandlerCompleted(msg, startedAt, 'success');
        },
        (err: unknown) => {
          logger.error(`Ordered handler error (${subject}):`, err);
          reportHandlerCompleted(msg, startedAt, 'error');
        },
      );
    };

    const route = isOrdered ? handleOrderedSafe : handleSafe;

    // Concurrency limiter: up to `maxActive` messages are routed in parallel;
    // anything beyond queues into `backlog` and is drained FIFO as each
    // in-flight message completes. Ordered streams pin the limit to 1 so
    // delivery stays strictly sequential.
    const maxActive = isOrdered ? 1 : (concurrency ?? Number.POSITIVE_INFINITY);
    const backlogWarnThreshold = 1_000;
    let active = 0;
    let backlogWarned = false;
    const backlog: JsMsg[] = [];

    const onAsyncDone = (): void => {
      active--;
      drainBacklog();
    };

    // route() is not expected to throw — every settlement inside it is
    // guarded — but a failure here must never leak the concurrency slot or
    // escape into the RxJS observer and kill the subscription.
    const routeSafely = (msg: JsMsg): Promise<void> | undefined => {
      try {
        return route(msg);
      } catch (err) {
        logger.error(`Unexpected routing failure for ${msg.subject}:`, err);

        return undefined;
      }
    };

    const trackAsync = (result: Promise<void>, msg: JsMsg): void => {
      void result
        .catch((err: unknown) => {
          logger.error(`Unexpected routing failure for ${msg.subject}:`, err);
        })
        .finally(onAsyncDone);
    };

    const drainBacklog = (): void => {
      while (active < maxActive) {
        const next = backlog.shift();

        if (next === undefined) return;
        active++;
        const result = routeSafely(next);

        if (result !== undefined) {
          trackAsync(result, next);
        } else {
          active--;
        }
      }

      if (backlog.length < backlogWarnThreshold) backlogWarned = false;
    };

    const subscription = stream$.subscribe({
      next: (msg: JsMsg): void => {
        if (active >= maxActive) {
          backlog.push(msg);
          if (!backlogWarned && backlog.length >= backlogWarnThreshold) {
            backlogWarned = true;
            logger.warn(
              `${kind} backlog reached ${backlog.length} messages — consumer may be falling behind`,
            );
          }

          return;
        }

        active++;
        const result = routeSafely(msg);

        if (result !== undefined) {
          trackAsync(result, msg);
        } else {
          active--;
          if (backlog.length > 0) drainBacklog();
        }
      },
      error: (err: unknown): void => {
        logger.error(`Stream error in ${kind} router`, err);
      },
    });

    this.subscriptions.push(subscription);
  }

  private getConcurrency(kind: StreamKind): number | undefined {
    if (kind === StreamKind.Event) return this.processingConfig?.events?.concurrency;
    if (kind === StreamKind.Broadcast) return this.processingConfig?.broadcast?.concurrency;
    return undefined;
  }

  private getAckExtensionConfig(kind: StreamKind): boolean | number | undefined {
    if (kind === StreamKind.Event) return this.processingConfig?.events?.ackExtension;
    if (kind === StreamKind.Broadcast) return this.processingConfig?.broadcast?.ackExtension;
    return undefined;
  }

  /**
   * Last-resort path for a dead letter: invoke `onDeadLetter`, then `term` on
   * success. On failure the message is nak'd to release it, but the server
   * never redelivers past `max_deliver` — it stays in the stream for manual
   * recovery. Used when the DLQ stream isn't configured, or when publishing
   * to it failed and we still have to surface the message somewhere.
   */
  private async fallbackToOnDeadLetterCallback(info: DeadLetterInfo, msg: JsMsg): Promise<void> {
    const onDeadLetter = this.deadLetterConfig?.onDeadLetter;

    if (!onDeadLetter) {
      // dlq-only mode and the DLQ publish failed: there is no callback to fall
      // back to. Keep the message in the stream rather than deleting it.
      this.logger.error(
        `Dead letter for ${msg.subject} could not be captured (DLQ publish failed, no onDeadLetter callback) — leaving the message in the stream`,
      );
      settleQuietly(this.logger, `Failed to nak ${msg.subject}:`, () => {
        msg.nak();
      });

      return;
    }

    try {
      await onDeadLetter(info);
      settleQuietly(this.logger, `Failed to term ${msg.subject}:`, () => {
        msg.term('Dead letter processed via fallback callback');
      });
    } catch (hookErr) {
      this.logger.error(
        `Fallback onDeadLetter callback failed for ${msg.subject} — the message stays in the stream and will not be redelivered (max_deliver exhausted); recover it manually:`,
        hookErr,
      );
      settleQuietly(this.logger, `Failed to nak ${msg.subject}:`, () => {
        msg.nak();
      });
    }
  }

  /**
   * Copy the original message headers for the DLQ republish, dropping NATS
   * server control headers: a copied Nats-TTL expires the DLQ entry (or gets
   * the publish rejected when the DLQ stream has no allow_msg_ttl), a copied
   * Nats-Msg-Id collides with the DLQ dedup window.
   */
  private buildDlqHeaders(msg: JsMsg): MsgHdrs {
    const hdrs = natsHeaders();

    if (!msg.headers) return hdrs;

    for (const [k, v] of msg.headers) {
      if (k.toLowerCase().startsWith(NATS_CONTROL_HEADER_PREFIX)) continue;

      for (const val of v) {
        hdrs.append(k, val);
      }
    }

    return hdrs;
  }

  /**
   * Attempt the DLQ publish up to {@link DLQ_PUBLISH_ATTEMPTS} times.
   *
   * Past `max_deliver` the server never redelivers, so an in-process retry is
   * the only second chance a dead letter gets. There is no artificial delay
   * between attempts: when the broker is unreachable each publish already
   * spends its own request timeout, which spaces the attempts naturally.
   */
  private async publishToDlqWithRetry(
    connection: ConnectionProvider,
    subject: string,
    data: Uint8Array,
    headers: MsgHdrs,
  ): Promise<void> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= DLQ_PUBLISH_ATTEMPTS; attempt += 1) {
      try {
        await connection.getJetStreamClient().publish(subject, data, { headers });

        return;
      } catch (err) {
        lastErr = err;

        if (attempt < DLQ_PUBLISH_ATTEMPTS) {
          this.logger.warn(
            `DLQ publish attempt ${attempt}/${DLQ_PUBLISH_ATTEMPTS} failed for ${subject}, retrying`,
          );
        }
      }
    }

    throw lastErr;
  }

  /**
   * Publish a dead letter to the configured Dead-Letter Queue (DLQ) stream.
   *
   * Appends diagnostic metadata headers to the original message and preserves
   * the primary payload. If publishing succeeds, it notifies the standard
   * `onDeadLetter` callback and terminates the message. If it fails, it falls
   * back to the callback entirely to prevent silent data loss.
   */
  private async publishToDlq(msg: JsMsg, info: DeadLetterInfo, error: unknown): Promise<void> {
    const serviceName = this.options?.name;

    if (!this.connection || !serviceName) {
      this.logger.error(
        `Cannot publish to DLQ for ${msg.subject}: Connection or Module Options unavailable`,
      );
      await this.fallbackToOnDeadLetterCallback(info, msg);
      return;
    }

    const destinationSubject = dlqStreamName(serviceName);
    const hdrs = this.buildDlqHeaders(msg);

    let reason = String(error);

    if (error instanceof Error) {
      reason = error.message;
    } else if (typeof error === 'object' && error !== null && 'message' in error) {
      reason = String((error as Record<string, unknown>).message);
    }

    hdrs.set(JetstreamDlqHeader.DeadLetterReason, reason);
    hdrs.set(JetstreamDlqHeader.OriginalSubject, msg.subject);
    hdrs.set(JetstreamDlqHeader.OriginalStream, msg.info.stream);
    hdrs.set(JetstreamDlqHeader.FailedAt, new Date().toISOString());
    hdrs.set(JetstreamDlqHeader.DeliveryCount, msg.info.deliveryCount.toString());

    try {
      await this.publishToDlqWithRetry(this.connection, destinationSubject, msg.data, hdrs);
      this.logger.log(`Message sent to DLQ: ${msg.subject}`);

      if (this.deadLetterConfig?.onDeadLetter) {
        try {
          await this.deadLetterConfig.onDeadLetter(info);
        } catch (hookErr) {
          this.logger.warn(
            `onDeadLetter callback failed after successful DLQ publish for ${msg.subject}`,
            hookErr,
          );
        }
      }

      settleQuietly(this.logger, `Failed to term ${msg.subject}:`, () => {
        msg.term('Moved to DLQ stream');
      });
    } catch (publishErr) {
      this.logger.error(`Failed to publish to DLQ for ${msg.subject}:`, publishErr);
      await this.fallbackToOnDeadLetterCallback(info, msg);
    }
  }

  /**
   * Orchestrates the handling of a message that has exhausted delivery limits.
   *
   * Emits a system event and delegates either to the robust DLQ stream publisher
   * or directly to the fallback callback based on the active module configuration.
   */
  private async handleDeadLetter(msg: JsMsg, data: unknown, error: unknown): Promise<void> {
    const info: DeadLetterInfo = {
      subject: msg.subject,
      data,
      headers: msg.headers,
      error,
      deliveryCount: msg.info.deliveryCount,
      stream: msg.info.stream,
      streamSequence: msg.info.streamSequence,
      timestamp: new Date(msg.info.timestampNanos / 1_000_000).toISOString(),
    };

    await withDeadLetterSpan(
      {
        msg,
        // Pattern resolution mirrors event-routing: when a registered
        // pattern matches, surface it on the DLQ span so APM can filter
        // dead letters by handler without parsing the subject. Falls back
        // to the subject itself when no glob handler is in play.
        pattern: this.patternRegistry.getHandler(msg.subject) ? msg.subject : undefined,
        finalDeliveryCount: msg.info.deliveryCount,
        reason: error instanceof Error ? error.message : String(error),
        serviceName: this.serviceName,
        endpoint: this.serverEndpoint,
      },
      this.otel,
      async () => {
        this.eventBus.emit(TransportEvent.DeadLetter, info);

        if (!this.options?.dlq) {
          await this.fallbackToOnDeadLetterCallback(info, msg);
        } else {
          await this.publishToDlq(msg, info, error);
        }
      },
    );
  }
}
