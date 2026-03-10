import { Logger } from '@nestjs/common';
import { MessageHandler } from '@nestjs/microservices';
import { headers, JsMsg } from 'nats';
import { catchError, EMPTY, from, mergeMap, Observable, Subscription } from 'rxjs';

import { ConnectionProvider } from '../../connection';
import { RpcContext } from '../../context';
import { EventBus } from '../../hooks';
import { TransportEvent } from '../../interfaces';
import type { Codec } from '../../interfaces';
import { DEFAULT_JETSTREAM_RPC_TIMEOUT, JetstreamHeader } from '../../jetstream.constants';
import { unwrapResult } from '../../utils';

import { MessageProvider } from '../infrastructure/message.provider';
import { PatternRegistry } from './pattern-registry';

/**
 * Routes RPC command messages in JetStream mode.
 *
 * Delivery semantics:
 * - Handler must complete within timeout (default: 3 min)
 * - Success -> publish response to ReplyTo -> ack
 * - Handler error -> publish error to ReplyTo -> term (no redelivery)
 * - Timeout -> no response -> term
 * - No handler / decode error -> term immediately
 *
 * Nak is never used for RPC — prevents duplicate side effects.
 */
export class RpcRouter {
  private readonly logger = new Logger(RpcRouter.name);
  private readonly timeout: number;
  private subscription: Subscription | null = null;

  public constructor(
    private readonly messageProvider: MessageProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly connection: ConnectionProvider,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
    timeout?: number,
  ) {
    this.timeout = timeout ?? DEFAULT_JETSTREAM_RPC_TIMEOUT;
  }

  /** Start routing command messages to handlers. */
  public start(): void {
    this.subscription = this.messageProvider.commands$
      .pipe(
        mergeMap((msg) => this.handle(msg)),
        catchError((err, caught) => {
          this.logger.error('Unexpected error in RPC router', err);
          return caught;
        }),
      )
      .subscribe();
  }

  /** Stop routing and unsubscribe. */
  public destroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  /** Handle a single RPC command message. */
  private handle(msg: JsMsg): Observable<void> {
    const handler = this.patternRegistry.getHandler(msg.subject);

    if (!handler) {
      msg.term(`No handler for RPC: ${msg.subject}`);
      this.logger.error(`No handler for RPC subject: ${msg.subject}`);
      return EMPTY;
    }

    const replyTo = msg.headers?.get(JetstreamHeader.ReplyTo);
    const correlationId = msg.headers?.get(JetstreamHeader.CorrelationId);

    if (!replyTo || !correlationId) {
      msg.term('Missing required headers (reply-to or correlation-id)');
      this.logger.error(`Missing headers for RPC: ${msg.subject}`);
      return EMPTY;
    }

    let data: unknown;

    try {
      data = this.codec.decode(msg.data);
    } catch (err) {
      msg.term('Decode error');
      this.logger.error(`Decode error for RPC ${msg.subject}:`, err);
      return EMPTY;
    }

    this.eventBus.emit(TransportEvent.MessageRouted, msg.subject, 'rpc');

    return from(this.executeHandler(handler, data, msg, replyTo, correlationId));
  }

  /** Execute handler, publish response, settle message. */
  private async executeHandler(
    handler: MessageHandler,
    data: unknown,
    msg: JsMsg,
    replyTo: string,
    correlationId: string,
  ): Promise<void> {
    const nc = await this.connection.getConnection();
    const ctx = new RpcContext([msg]);

    const hdrs = headers();

    hdrs.set(JetstreamHeader.CorrelationId, correlationId);

    let settled = false;

    // Race handler against timeout
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.logger.error(`RPC timeout (${this.timeout}ms): ${msg.subject}`);
      this.eventBus.emit(TransportEvent.RpcTimeout, msg.subject, correlationId);
      msg.term('Handler timeout');
    }, this.timeout);

    try {
      const result = await unwrapResult(handler(data, ctx));

      // settled may be set by the setTimeout callback above (async race)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      // Publish success response
      nc.publish(replyTo, this.codec.encode(result), { headers: hdrs });
      msg.ack();
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      // Publish error response
      try {
        const errorPayload = { error: err instanceof Error ? err.message : String(err) };

        nc.publish(replyTo, this.codec.encode(errorPayload), { headers: hdrs });
      } catch (encodeErr) {
        this.logger.error(`Failed to encode RPC error for ${msg.subject}`, encodeErr);
      }

      msg.term(`Handler error: ${msg.subject}`);
    }
  }
}
