import { Logger } from '@nestjs/common';
import { MessageHandler } from '@nestjs/microservices';
import type { JsMsg } from '@nats-io/jetstream';
import { concatMap, from, mergeMap, Observable, Subscription } from 'rxjs';

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
import { resolveAckExtensionInterval, startAckExtensionTimer, unwrapResult } from '../../utils';

import { MessageProvider } from '../infrastructure';
import { PatternRegistry } from './pattern-registry';
import { dlqStreamName, JetstreamDlqHeader } from '../../jetstream.constants';

/**
 * Routes incoming event messages (workqueue, broadcast, and ordered) to NestJS handlers.
 *
 * **Workqueue & Broadcast** — at-least-once delivery:
 * - Success -> ack | Error -> nak (retry) | Dead letter -> term
 *
 * **Ordered** — strict sequential delivery:
 * - No ack/nak/DLQ — nats.js auto-acknowledges ordered consumer messages.
 * - Handler errors are logged but do not affect delivery.
 *
 * **Dead-Letter Queue (DLQ) - for handling failed message deliveries**
 * - If `options.dlq` is configured, messages that exhaust their max delivery attempts are published to a DLQ stream.
 * - The DLQ stream name is derived from the service name (e.g., `orders__microservice_dlq-stream`).
 * - Original message data and metadata are preserved in the DLQ message, with additional headers indicating the reason for failure.
 */
export class EventRouter {
  private readonly logger = new Logger('Jetstream:EventRouter');
  private readonly subscriptions: Subscription[] = [];

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
  ) {}

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

  /** Subscribe to a message stream and route each message. */
  private subscribeToStream(stream$: Observable<JsMsg>, kind: StreamKind): void {
    const isOrdered = kind === StreamKind.Ordered;

    // Resolve once per stream — these never change after startup
    const ackExtensionInterval = isOrdered
      ? null
      : resolveAckExtensionInterval(this.getAckExtensionConfig(kind), this.ackWaitMap?.get(kind));
    const concurrency = this.getConcurrency(kind);

    const route = (msg: JsMsg): Observable<void> =>
      from(
        isOrdered ? this.handleOrderedSafe(msg) : this.handleSafe(msg, ackExtensionInterval, kind),
      );

    const subscription = stream$
      .pipe(isOrdered ? concatMap(route) : mergeMap(route, concurrency))
      .subscribe();

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

  /** Handle a single event message with error isolation. */
  private async handleSafe(
    msg: JsMsg,
    ackExtensionInterval: number | null,
    kind: StreamKind,
  ): Promise<void> {
    try {
      const resolved = this.decodeMessage(msg);

      if (!resolved) return;

      await this.executeHandler(
        resolved.handler,
        resolved.data,
        resolved.ctx,
        msg,
        ackExtensionInterval,
      );
    } catch (err) {
      this.logger.error(`Unexpected error in ${kind} event router`, err);
    }
  }

  /** Handle an ordered message with error isolation. */
  private async handleOrderedSafe(msg: JsMsg): Promise<void> {
    try {
      const resolved = this.decodeMessage(msg, true);

      if (!resolved) return;

      await unwrapResult(resolved.handler(resolved.data, resolved.ctx));

      if (resolved.ctx.shouldRetry || resolved.ctx.shouldTerminate) {
        this.logger.warn(
          `retry()/terminate() ignored for ordered message ${msg.subject} — ordered consumers auto-acknowledge`,
        );
      }
    } catch (err) {
      this.logger.error(`Ordered handler error (${msg.subject}):`, err);
    }
  }

  /** Resolve handler, decode payload, and build context. Returns null on failure. */
  private decodeMessage(
    msg: JsMsg,
    isOrdered = false,
  ): { handler: MessageHandler; data: unknown; ctx: RpcContext } | null {
    const handler = this.patternRegistry.getHandler(msg.subject);

    if (!handler) {
      if (!isOrdered) msg.term(`No handler for event: ${msg.subject}`);
      this.logger.error(`No handler for subject: ${msg.subject}`);
      return null;
    }

    let data: unknown;

    try {
      data = this.codec.decode(msg.data);
    } catch (err) {
      if (!isOrdered) msg.term('Decode error');
      this.logger.error(`Decode error for ${msg.subject}:`, err);
      return null;
    }

    this.eventBus.emitMessageRouted(msg.subject, MessageKind.Event);

    return { handler, data, ctx: new RpcContext([msg]) };
  }

  /** Execute handler, then ack on success or nak/dead-letter on failure. */
  private async executeHandler(
    handler: MessageHandler,
    data: unknown,
    ctx: RpcContext,
    msg: JsMsg,
    ackExtensionInterval: number | null,
  ): Promise<void> {
    const stopAckExtension = startAckExtensionTimer(msg, ackExtensionInterval);

    try {
      await unwrapResult(handler(data, ctx));

      if (ctx.shouldTerminate) {
        msg.term(ctx.terminateReason);
      } else if (ctx.shouldRetry) {
        msg.nak(ctx.retryDelay);
      } else {
        msg.ack();
      }
    } catch (err) {
      this.logger.error(`Event handler error (${msg.subject}):`, err);

      if (this.isDeadLetter(msg)) {
        await this.handleDeadLetter(msg, data, err);
      } else {
        msg.nak();
      }
    } finally {
      stopAckExtension?.();
    }
  }

  /** Check if the message has exhausted all delivery attempts. */
  private isDeadLetter(msg: JsMsg): boolean {
    if (!this.deadLetterConfig) return false;

    const maxDeliver = this.deadLetterConfig.maxDeliverByStream.get(msg.info.stream);

    if (maxDeliver === undefined || maxDeliver <= 0) return false;

    return msg.info.deliveryCount >= maxDeliver;
  }

  /** Handle a dead letter: invoke callback, then term or nak based on result. */

  /**
   * Fallback execution for a dead letter when DLQ is disabled, or when
   * publishing to the DLQ stream fails (due to network or NATS errors).
   *
   * Triggers the user-provided `onDeadLetter` hook for logging/alerting.
   * On success, terminates the message. On error, leaves it unacknowledged (nak)
   * so NATS can retry the delivery on the next cycle.
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

    const js = this.connection.getJetStreamClient();
    const destinationSubject = dlqStreamName(serviceName);
    const hdrs = natsHeaders();

    if (msg.headers) {
      for (const [k, v] of msg.headers) {
        for (const val of v) {
          hdrs.append(k, val);
        }
      }
    }

    const reason =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as Record<string, unknown>).message)
          : String(error);

    hdrs.set(JetstreamDlqHeader.DeadLetterReason, reason);
    hdrs.set(JetstreamDlqHeader.OriginalSubject, msg.subject);
    hdrs.set(JetstreamDlqHeader.OriginalStream, msg.info.stream);
    hdrs.set(JetstreamDlqHeader.FailedAt, info.timestamp);
    hdrs.set(JetstreamDlqHeader.DeliveryCount, msg.info.deliveryCount.toString());

    try {
      await js.publish(destinationSubject, msg.data, { headers: hdrs });
      this.logger.log(`Message sent to DLQ: ${msg.subject}`);

      /** Republish succeeds - call onDeadLetter for notification/logging */

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

    this.eventBus.emit(TransportEvent.DeadLetter, info);

    if (!this.options?.dlq) {
      await this.fallbackToOnDeadLetterCallback(info, msg);
    } else {
      await this.publishToDlq(msg, info, error);
    }
  }
}
