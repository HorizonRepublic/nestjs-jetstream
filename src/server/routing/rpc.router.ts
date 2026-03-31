import { Logger } from '@nestjs/common';
import { MessageHandler } from '@nestjs/microservices';
import { headers, type NatsConnection } from '@nats-io/transport-node';
import type { JsMsg } from '@nats-io/jetstream';
import { from, mergeMap, Subscription } from 'rxjs';

import { ConnectionProvider } from '../../connection';
import { RpcContext } from '../../context';
import { EventBus } from '../../hooks';
import { MessageKind, StreamKind, TransportEvent } from '../../interfaces';
import type { Codec, RpcRouterOptions } from '../../interfaces';
import { DEFAULT_JETSTREAM_RPC_TIMEOUT, JetstreamHeader } from '../../jetstream.constants';
import {
  resolveAckExtensionInterval,
  serializeError,
  startAckExtensionTimer,
  unwrapResult,
} from '../../utils';

import { MessageProvider } from '../infrastructure';
import { PatternRegistry } from './pattern-registry';

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
 * Nak is never used for RPC — prevents duplicate side effects.
 */
export class RpcRouter {
  private readonly logger = new Logger('Jetstream:RpcRouter');
  private readonly timeout: number;
  private readonly concurrency: number | undefined;
  private resolvedAckExtensionInterval: number | null | undefined;
  private subscription: Subscription | null = null;
  private cachedNc: NatsConnection | null = null;

  public constructor(
    private readonly messageProvider: MessageProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly connection: ConnectionProvider,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
    private readonly rpcOptions?: RpcRouterOptions,
    private readonly ackWaitMap?: Map<StreamKind, number>,
  ) {
    this.timeout = rpcOptions?.timeout ?? DEFAULT_JETSTREAM_RPC_TIMEOUT;
    this.concurrency = rpcOptions?.concurrency;
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
    this.subscription = this.messageProvider.commands$
      .pipe(mergeMap((msg) => from(this.handleSafe(msg)), this.concurrency))
      .subscribe();
  }

  /** Stop routing and unsubscribe. */
  public destroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  /** Handle a single RPC command message with error isolation. */
  private async handleSafe(msg: JsMsg): Promise<void> {
    try {
      const handler = this.patternRegistry.getHandler(msg.subject);

      if (!handler) {
        msg.term(`No handler for RPC: ${msg.subject}`);
        this.logger.error(`No handler for RPC subject: ${msg.subject}`);
        return;
      }

      const { headers: msgHeaders } = msg;
      const replyTo = msgHeaders?.get(JetstreamHeader.ReplyTo);
      const correlationId = msgHeaders?.get(JetstreamHeader.CorrelationId);

      if (!replyTo || !correlationId) {
        msg.term('Missing required headers (reply-to or correlation-id)');
        this.logger.error(`Missing headers for RPC: ${msg.subject}`);
        return;
      }

      let data: unknown;

      try {
        data = this.codec.decode(msg.data);
      } catch (err) {
        msg.term('Decode error');
        this.logger.error(`Decode error for RPC ${msg.subject}:`, err);
        return;
      }

      this.eventBus.emitMessageRouted(msg.subject, MessageKind.Rpc);

      await this.executeHandler(handler, data, msg, replyTo, correlationId);
    } catch (err) {
      this.logger.error('Unexpected error in RPC router', err);
    }
  }

  /** Execute handler, publish response, settle message. */
  private async executeHandler(
    handler: MessageHandler,
    data: unknown,
    msg: JsMsg,
    replyTo: string,
    correlationId: string,
  ): Promise<void> {
    const nc = this.cachedNc ?? (await this.connection.getConnection());
    const ctx = new RpcContext([msg]);

    let settled = false;

    // Ack extension: keep NATS happy while handler runs
    const stopAckExtension = startAckExtensionTimer(msg, this.ackExtensionInterval);

    // Race handler against timeout
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopAckExtension?.();
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
      stopAckExtension?.();

      msg.ack();

      try {
        const hdrs = headers();

        hdrs.set(JetstreamHeader.CorrelationId, correlationId);
        nc.publish(replyTo, this.codec.encode(result), { headers: hdrs });
      } catch (publishErr) {
        this.logger.error(`Failed to publish RPC response for ${msg.subject}`, publishErr);
      }
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      stopAckExtension?.();

      try {
        const hdrs = headers();

        hdrs.set(JetstreamHeader.CorrelationId, correlationId);
        hdrs.set(JetstreamHeader.Error, 'true');
        nc.publish(replyTo, this.codec.encode(serializeError(err)), { headers: hdrs });
      } catch (encodeErr) {
        this.logger.error(`Failed to encode RPC error for ${msg.subject}`, encodeErr);
      }

      msg.term(`Handler error: ${msg.subject}`);
    }
  }
}
