import { Logger } from '@nestjs/common';
import { MessageHandler } from '@nestjs/microservices';
import type { JsMsg } from '@nats-io/jetstream';
import { Observable, Subscription } from 'rxjs';

import { RpcContext } from '../../context';
import { EventBus } from '../../hooks';
import { MessageKind, StreamKind, TransportEvent } from '../../interfaces';
import { ConnectionProvider } from '../../connection';
import { headers as natsHeaders } from '@nats-io/transport-node';

import type {
  Codec,
  DeadLetterConfig,
  DeadLetterInfo,
  EventProcessingConfig,
  JetstreamModuleOptions,
} from '../../interfaces';
import {
  isPromiseLike,
  resolveAckExtensionInterval,
  startAckExtensionTimer,
  unwrapResult,
} from '../../utils';

import { MessageProvider } from '../infrastructure';
import { PatternRegistry } from './pattern-registry';
import { dlqStreamName, JetstreamDlqHeader } from '../../jetstream.constants';
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
    const emitRouted = eventBus.hasHook(TransportEvent.MessageRouted);

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

    const settleSuccess = (msg: JsMsg, ctx: RpcContext): void => {
      if (ctx.shouldTerminate) msg.term(ctx.terminateReason);
      else if (ctx.shouldRetry) msg.nak(ctx.retryDelay);
      else msg.ack();
    };

    const settleFailure = async (msg: JsMsg, data: unknown, err: unknown): Promise<void> => {
      if (handleDeadLetter !== null && isDeadLetter(msg)) {
        await handleDeadLetter(msg, data, err);

        return;
      }

      msg.nak();
    };

    /**
     * Resolve the handler and decode payload for one event.
     *
     * Returns `null` when the message cannot be routed (no handler, decode
     * error, or unexpected pre-dispatch failure) — those branches settle the
     * message synchronously inside the helper and produce nothing to dispatch.
     */
    const resolveEvent = (msg: JsMsg): ResolvedEvent | null => {
      const subject = msg.subject;

      try {
        const handler = patternRegistry.getHandler(subject);

        if (!handler) {
          msg.term(`No handler for event: ${subject}`);
          logger.error(`No handler for subject: ${subject}`);

          return null;
        }

        let data: unknown;

        try {
          data = codec.decode(msg.data);
        } catch (err) {
          msg.term('Decode error');
          logger.error(`Decode error for ${subject}:`, err);

          return null;
        }

        if (emitRouted) eventBus.emitMessageRouted(subject, MessageKind.Event);

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

      const { handler, data } = resolved;
      const ctx = new RpcContext([msg]);
      const stopAckExtension = hasAckExtension
        ? startAckExtensionTimer(msg, ackExtensionInterval)
        : null;

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
        settleSuccess(msg, ctx);
        if (stopAckExtension !== null) stopAckExtension();

        return undefined;
      }

      return (pending as Promise<unknown>).then(
        () => {
          settleSuccess(msg, ctx);
          if (stopAckExtension !== null) stopAckExtension();
        },
        async (err: unknown) => {
          eventBus.emit(
            TransportEvent.Error,
            err instanceof Error ? err : new Error(String(err)),
            `${kind}-handler:${msg.subject}`,
          );
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

        if (emitRouted) eventBus.emitMessageRouted(subject, MessageKind.Event);
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

        return undefined;
      }

      if (!isPromiseLike(pending)) {
        warnIfSettlementAttempted();

        return undefined;
      }

      return (pending as Promise<unknown>).then(warnIfSettlementAttempted, (err: unknown) => {
        logger.error(`Ordered handler error (${subject}):`, err);
      });
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

    const drainBacklog = (): void => {
      while (active < maxActive) {
        const next = backlog.shift();

        if (next === undefined) return;
        active++;
        const result = route(next);

        if (result !== undefined) {
          void result.finally(onAsyncDone);
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
        const result = route(msg);

        if (result !== undefined) {
          void result.finally(onAsyncDone);
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
   * success or `nak` on hook failure so NATS retries on the next delivery
   * cycle. Used when DLQ stream isn't configured, or when publishing to it
   * failed and we still have to surface the message somewhere observable.
   */
  private async fallbackToOnDeadLetterCallback(info: DeadLetterInfo, msg: JsMsg): Promise<void> {
    // Safety net: deadLetterConfig is guaranteed by isDeadLetter() guard,
    // but if somehow null, term the message to prevent infinite redelivery.
    if (!this.deadLetterConfig) {
      msg.term('Dead letter config unavailable');
      return;
    }

    try {
      await this.deadLetterConfig.onDeadLetter(info);
      msg.term('Dead letter processed via fallback callback');
    } catch (hookErr) {
      this.logger.error(
        `Fallback onDeadLetter callback failed for ${msg.subject}, nak for retry:`,
        hookErr,
      );
      msg.nak();
    }
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
    const hdrs = natsHeaders();

    if (msg.headers) {
      for (const [k, v] of msg.headers) {
        for (const val of v) {
          hdrs.append(k, val);
        }
      }
    }

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
      const js = this.connection.getJetStreamClient();

      await js.publish(destinationSubject, msg.data, { headers: hdrs });
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

      msg.term('Moved to DLQ stream');
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
