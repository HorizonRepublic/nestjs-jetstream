import { Logger } from '@nestjs/common';
import { JsMsg } from 'nats';
import {
  catchError,
  defer,
  EMPTY,
  from,
  isObservable,
  lastValueFrom,
  mergeMap,
  Observable,
  Subscription,
} from 'rxjs';

import { RpcContext } from '../../context';
import { EventBus } from '../../hooks';
import { TransportEvent } from '../../interfaces';
import type { Codec, DeadLetterInfo } from '../../interfaces';

import { MessageProvider } from '../infrastructure';
import { PatternRegistry } from './pattern-registry';

/** Options for dead letter queue handling. */
export interface DeadLetterConfig {
  /**
   * Map of stream name -> max_deliver value.
   * Used to detect when a message from a given stream has exhausted all delivery attempts.
   */
  maxDeliverByStream: Map<string, number>;
  /** Async callback invoked when a message exhausts all deliveries. */
  onDeadLetter(info: DeadLetterInfo): Promise<void>;
}

/**
 * Routes incoming event messages (workqueue and broadcast) to NestJS handlers.
 *
 * Delivery semantics (at-least-once):
 * - Handler executes first
 * - Success -> ack (message consumed)
 * - Handler error -> nak (NATS redelivers, up to `max_deliver` times)
 * - Dead letter (max_deliver reached) -> onDeadLetter hook -> term or nak
 * - Decode error -> term (no retry for malformed payloads)
 * - No handler found -> term (configuration error)
 *
 * Both workqueue and broadcast use the same ack/nak semantics.
 * Each durable consumer tracks delivery independently, so a nak from
 * one broadcast consumer does not affect others.
 *
 * Handlers must be idempotent — NATS may redeliver on failure or timeout.
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
  ) {}

  /**
   * Update the max_deliver thresholds from actual NATS consumer configs.
   * Called after consumers are ensured so the DLQ map reflects reality.
   */
  public updateMaxDeliverMap(consumerMaxDelivers: Map<string, number>): void {
    if (!this.deadLetterConfig) return;
    this.deadLetterConfig.maxDeliverByStream = consumerMaxDelivers;
  }

  /** Start routing event and broadcast messages to handlers. */
  public start(): void {
    this.subscribeToStream(this.messageProvider.events$, 'workqueue');
    this.subscribeToStream(this.messageProvider.broadcasts$, 'broadcast');
  }

  /** Stop routing and unsubscribe from all streams. */
  public destroy(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }

    this.subscriptions.length = 0;
  }

  /** Subscribe to a message stream and route each message. */
  private subscribeToStream(stream$: Observable<JsMsg>, label: string): void {
    const subscription = stream$
      .pipe(
        mergeMap((msg) =>
          defer(() => this.handle(msg)).pipe(
            catchError((err) => {
              this.logger.error(`Unexpected error in ${label} event router`, err);
              return EMPTY;
            }),
          ),
        ),
      )
      .subscribe();

    this.subscriptions.push(subscription);
  }

  /** Handle a single event message: decode -> execute handler -> ack/nak. */
  private handle(msg: JsMsg): Observable<void> {
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

    this.eventBus.emit(TransportEvent.MessageRouted, msg.subject, 'event');

    const ctx = new RpcContext([msg]);

    return from(this.executeHandler(handler, data, ctx, msg));
  }

  /** Execute handler, then ack on success or nak/dead-letter on failure. */
  private async executeHandler(
    handler: (data: unknown, ctx: RpcContext) => Promise<unknown>,
    data: unknown,
    ctx: RpcContext,
    msg: JsMsg,
  ): Promise<void> {
    try {
      const result = await handler(data, ctx);

      if (isObservable(result)) {
        await lastValueFrom(result, { defaultValue: undefined });
      }

      msg.ack();
    } catch (err) {
      this.logger.error(`Event handler error (${msg.subject}):`, err);

      if (this.isDeadLetter(msg)) {
        await this.handleDeadLetter(msg, data, err);
      } else {
        msg.nak();
      }
    }
  }

  /** Check if the message has exhausted all delivery attempts. */
  private isDeadLetter(msg: JsMsg): boolean {
    if (!this.deadLetterConfig) return false;

    const maxDeliver = this.deadLetterConfig.maxDeliverByStream.get(msg.info.stream);

    if (maxDeliver === undefined) return false;

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

    if (!this.deadLetterConfig) return;

    try {
      await this.deadLetterConfig.onDeadLetter(info);
      msg.term('Dead letter processed');
    } catch (hookErr) {
      this.logger.error(`onDeadLetter callback failed for ${msg.subject}, nak for retry:`, hookErr);
      msg.nak();
    }
  }
}
