import { Logger } from '@nestjs/common';
import { JsMsg } from 'nats';
import {
  catchError,
  concatMap,
  defer,
  EMPTY,
  from,
  mergeMap,
  Observable,
  Subscription,
} from 'rxjs';

import { RpcContext } from '../../context';
import { EventBus } from '../../hooks';
import { MessageKind, StreamKind, TransportEvent } from '../../interfaces';
import type { Codec, DeadLetterConfig, DeadLetterInfo, EventProcessingConfig } from '../../interfaces';
import { resolveAckExtensionInterval, startAckExtensionTimer, unwrapResult } from '../../utils';

import { MessageProvider } from '../infrastructure';
import { PatternRegistry } from './pattern-registry';

/**
 * Routes incoming event messages (workqueue, broadcast, and ordered) to NestJS handlers.
 *
 * **Workqueue & Broadcast** — at-least-once delivery:
 * - Success -> ack | Error -> nak (retry) | Dead letter -> term
 *
 * **Ordered** — strict sequential delivery:
 * - No ack/nak/DLQ — nats.js auto-acknowledges ordered consumer messages.
 * - Handler errors are logged but do not affect delivery.
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
    private readonly ackWaitMap?: Map<string, number>,
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
    this.subscribeToStream(this.messageProvider.events$, 'workqueue');
    this.subscribeToStream(this.messageProvider.broadcasts$, 'broadcast');

    if (this.patternRegistry.hasOrderedHandlers()) {
      this.subscribeToStream(this.messageProvider.ordered$, 'ordered', true);
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
  private subscribeToStream(stream$: Observable<JsMsg>, label: string, isOrdered = false): void {
    const route = (msg: JsMsg): Observable<void> =>
      defer(() => (isOrdered ? this.handleOrdered(msg) : this.handle(msg, label))).pipe(
        catchError((err) => {
          this.logger.error(`Unexpected error in ${label} event router`, err);
          return EMPTY;
        }),
      );

    // Ordered streams use concatMap for strict sequential processing;
    // workqueue/broadcast use mergeMap for parallel handler execution.
    const concurrency = this.getConcurrency(label);
    const subscription = stream$
      .pipe(isOrdered ? concatMap(route) : mergeMap(route, concurrency))
      .subscribe();

    this.subscriptions.push(subscription);
  }

  private getConcurrency(label: string): number | undefined {
    if (label === 'workqueue') return this.processingConfig?.events?.concurrency;
    if (label === 'broadcast') return this.processingConfig?.broadcast?.concurrency;
    return undefined;
  }

  /** Handle a single event message: decode -> execute handler -> ack/nak. */
  private handle(msg: JsMsg, label: string): Observable<void> {
    const handler = this.patternRegistry.getHandler(msg.subject);

    if (!handler) {
      msg.term(`No handler for event: ${msg.subject}`);
      this.logger.error(`No handler for event subject: ${msg.subject}`);
      return EMPTY;
    }

    let data: unknown;

    try {
      data = this.codec.decode(msg.data);
    } catch (err) {
      msg.term('Decode error');
      this.logger.error(`Decode error for ${msg.subject}:`, err);
      return EMPTY;
    }

    this.eventBus.emit(TransportEvent.MessageRouted, msg.subject, MessageKind.Event);

    const ctx = new RpcContext([msg]);

    return from(this.executeHandler(handler, data, ctx, msg, label));
  }

  /** Execute handler, then ack on success or nak/dead-letter on failure. */
  private async executeHandler(
    handler: (data: unknown, ctx: RpcContext) => Promise<unknown>,
    data: unknown,
    ctx: RpcContext,
    msg: JsMsg,
    label: string,
  ): Promise<void> {
    const ackExtConfig = this.getAckExtensionConfig(label);
    const ackWaitNanos = this.getAckWaitNanos(label);
    const stopAckExtension = startAckExtensionTimer(
      msg,
      resolveAckExtensionInterval(ackExtConfig, ackWaitNanos),
    );

    try {
      await unwrapResult(handler(data, ctx));
      msg.ack();
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

  /** Handle an ordered message: decode -> execute handler -> no ack/nak. */
  private handleOrdered(msg: JsMsg): Observable<void> {
    const handler = this.patternRegistry.getHandler(msg.subject);

    if (!handler) {
      this.logger.error(`No handler for ordered subject: ${msg.subject}`);
      return EMPTY;
    }

    let data: unknown;

    try {
      data = this.codec.decode(msg.data);
    } catch (err) {
      this.logger.error(`Decode error for ordered ${msg.subject}:`, err);
      return EMPTY;
    }

    this.eventBus.emit(TransportEvent.MessageRouted, msg.subject, MessageKind.Event);

    const ctx = new RpcContext([msg]);

    return from(
      unwrapResult(handler(data, ctx)).catch((err: unknown) => {
        this.logger.error(`Ordered handler error (${msg.subject}):`, err);
      }),
    ) as Observable<void>;
  }

  private getAckExtensionConfig(label: string): boolean | number | undefined {
    if (label === 'workqueue') return this.processingConfig?.events?.ackExtension;
    if (label === 'broadcast') return this.processingConfig?.broadcast?.ackExtension;
    return undefined;
  }

  private getAckWaitNanos(label: string): number | undefined {
    const kind =
      label === 'workqueue'
        ? StreamKind.Event
        : label === 'broadcast'
          ? StreamKind.Broadcast
          : undefined;
    return kind ? this.ackWaitMap?.get(kind) : undefined;
  }

  /** Check if the message has exhausted all delivery attempts. */
  private isDeadLetter(msg: JsMsg): boolean {
    if (!this.deadLetterConfig) return false;

    const maxDeliver = this.deadLetterConfig.maxDeliverByStream.get(msg.info.stream);

    if (maxDeliver === undefined || maxDeliver <= 0) return false;

    return msg.info.deliveryCount >= maxDeliver;
  }

  /** Handle a dead letter: invoke callback, then term or nak based on result. */
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

    // Safety net: deadLetterConfig is guaranteed by isDeadLetter() guard,
    // but if somehow null, term the message to prevent infinite redelivery.
    if (!this.deadLetterConfig) {
      msg.term('Dead letter config unavailable');
      return;
    }

    try {
      await this.deadLetterConfig.onDeadLetter(info);
      msg.term('Dead letter processed');
    } catch (hookErr) {
      this.logger.error(`onDeadLetter callback failed for ${msg.subject}, nak for retry:`, hookErr);
      msg.nak();
    }
  }
}
