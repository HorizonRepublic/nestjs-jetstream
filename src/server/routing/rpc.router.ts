import { Logger } from '@nestjs/common';
import { MessageHandler } from '@nestjs/microservices';
import { headers, type NatsConnection } from '@nats-io/transport-node';
import type { JsMsg } from '@nats-io/jetstream';
import { Subscription } from 'rxjs';

import { ConnectionProvider } from '../../connection';
import { RpcContext } from '../../context';
import { EventBus } from '../../hooks';
import { MessageKind, StreamKind, TransportEvent } from '../../interfaces';
import type { Codec, RpcRouterOptions } from '../../interfaces';
import { DEFAULT_JETSTREAM_RPC_TIMEOUT, JetstreamHeader } from '../../jetstream.constants';
import {
  isPromiseLike,
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

    const nc = this.cachedNc;
    const patternRegistry = this.patternRegistry;
    const codec = this.codec;
    const eventBus = this.eventBus;
    const logger = this.logger;
    const timeout = this.timeout;
    const ackExtensionInterval = this.ackExtensionInterval;
    const hasAckExtension = ackExtensionInterval !== null && ackExtensionInterval > 0;
    const maxActive = this.concurrency ?? Number.POSITIVE_INFINITY;

    const emitRpcTimeout = (subject: string, correlationId: string): void => {
      eventBus.emit(TransportEvent.RpcTimeout, subject, correlationId);
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

    const resolveCommand = (
      msg: JsMsg,
    ): {
      handler: MessageHandler;
      data: unknown;
      replyTo: string;
      correlationId: string;
    } | null => {
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
        // connection is degraded — swallow that to keep the subscription alive.
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
     * The deadline `setTimeout` is only armed on the async branch — sync
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

      let pending: unknown;

      try {
        pending = unwrapResult(handler(data, ctx));
      } catch (err) {
        if (stopAckExtension !== null) stopAckExtension();
        logger.error(`RPC handler error (${subject}):`, err);
        publishErrorReply(replyTo, correlationId, subject, err);
        msg.term(`Handler error: ${subject}`);

        return undefined;
      }

      if (!isPromiseLike(pending)) {
        if (stopAckExtension !== null) stopAckExtension();
        msg.ack();
        publishReply(replyTo, correlationId, pending);

        return undefined;
      }

      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (stopAckExtension !== null) stopAckExtension();
        logger.error(`RPC timeout (${timeout}ms): ${subject}`);
        emitRpcTimeout(subject, correlationId);
        msg.term('Handler timeout');
      }, timeout);

      return (pending as Promise<unknown>).then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          if (stopAckExtension !== null) stopAckExtension();
          msg.ack();
          publishReply(replyTo, correlationId, result);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          if (stopAckExtension !== null) stopAckExtension();
          logger.error(`RPC handler error (${subject}):`, err);
          publishErrorReply(replyTo, correlationId, subject, err);
          msg.term(`Handler error: ${subject}`);
        },
      );
    };

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
        const result = handleSafe(next);

        if (result !== undefined) {
          void result.finally(onAsyncDone);
        } else {
          active--;
        }
      }

      if (backlog.length < backlogWarnThreshold) backlogWarned = false;
    };

    this.subscription = this.messageProvider.commands$.subscribe({
      next: (msg: JsMsg): void => {
        if (active >= maxActive) {
          backlog.push(msg);
          if (!backlogWarned && backlog.length >= backlogWarnThreshold) {
            backlogWarned = true;
            logger.warn(
              `RPC backlog reached ${backlog.length} messages — consumer may be falling behind`,
            );
          }

          return;
        }

        active++;
        const result = handleSafe(msg);

        if (result !== undefined) {
          void result.finally(onAsyncDone);
        } else {
          active--;
          if (backlog.length > 0) drainBacklog();
        }
      },
      error: (err: unknown): void => {
        logger.error('Stream error in RPC router', err);
      },
    });
  }

  /** Stop routing and unsubscribe. */
  public destroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }
}
