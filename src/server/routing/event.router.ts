import { Logger } from '@nestjs/common';
import { JsMsg } from 'nats';
import {
  catchError,
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
import type { Codec } from '../../interfaces';

import { MessageProvider } from '../infrastructure/message.provider';
import { PatternRegistry } from './pattern-registry';

/**
 * Routes incoming event messages (workqueue and broadcast) to NestJS handlers.
 *
 * Delivery semantics (at-least-once):
 * - Handler executes first
 * - Success -> ack (message consumed)
 * - Handler error -> nak (NATS redelivers, up to `max_deliver` times)
 * - Decode error -> term (no retry for malformed payloads)
 * - No handler found -> term (configuration error)
 *
 * Handlers must be idempotent — NATS may redeliver on failure or timeout.
 * For fire-and-forget events, use NATS Core via the standard NestJS transport.
 */
export class EventRouter {
  private readonly logger = new Logger('Jetstream:EventRouter');
  private readonly subscriptions: Subscription[] = [];

  public constructor(
    private readonly messageProvider: MessageProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
  ) {}

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
        mergeMap((msg) => this.handle(msg)),
        catchError((err, caught) => {
          this.logger.error(`Unexpected error in ${label} event router`, err);
          return caught;
        }),
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

  /** Execute handler, then ack on success or nak on failure. */
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
      msg.nak();
    }
  }
}
