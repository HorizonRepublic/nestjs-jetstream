import type { MessageHandler } from '@nestjs/microservices';

import type { JsMsg } from '@nats-io/jetstream';
import { headers } from '@nats-io/transport-node';

import { RpcContext } from '../../context';
import { MessageKind, StreamKind, TransportEvent } from '../../interfaces';
import { JetstreamHeader } from '../../jetstream.constants';
import { ConsumeKind, withConsumeSpan } from '../../otel';
import {
  isPromiseLike,
  serializeError,
  settleQuietly,
  startAckExtensionTimer,
  toError,
  unwrapResult,
} from '../../utils';
import { createHandlerReporter } from './handler-reporter';
import type { RouteFn, RpcPipelineContext } from './routing.types';

/**
 * Routing shape resolved for one incoming RPC command: the selected handler,
 * the decoded payload, and the reply coordinates read from the message headers.
 * The resolver returns `null` when the message cannot be routed and has
 * already been settled.
 */
interface ResolvedCommand {
  readonly handler: MessageHandler;
  readonly data: unknown;
  readonly replyTo: string;
  readonly correlationId: string;
}

/** Publishes the handler's result or error to the caller's reply inbox. */
interface RpcRepliers {
  publishReply(replyTo: string, correlationId: string, payload: unknown, subject: string): void;
  publishErrorReply(replyTo: string, correlationId: string, subject: string, err: unknown): void;
}

const createRepliers = (rctx: RpcPipelineContext): RpcRepliers => {
  const { nc, codec, logger } = rctx;

  const publishReply = (
    replyTo: string,
    correlationId: string,
    payload: unknown,
    subject: string,
  ): void => {
    try {
      const hdrs = headers();

      hdrs.set(JetstreamHeader.CorrelationId, correlationId);
      nc.publish(replyTo, codec.encode(payload), { headers: hdrs });
    } catch (publishErr) {
      // Staying silent here left the caller waiting out its full timeout for
      // a reply that was never going to be sent.
      logger.error(`Failed to publish RPC response`, publishErr);
      publishErrorReply(replyTo, correlationId, subject, publishErr);
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

  return { publishReply, publishErrorReply };
};

const createCommandResolver = (
  rctx: RpcPipelineContext,
): ((msg: JsMsg) => ResolvedCommand | null) => {
  const { patternRegistry, codec, eventBus, logger } = rctx;

  return (msg: JsMsg): ResolvedCommand | null => {
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
};

/**
 * Build the RPC pipeline. The returned function runs the full flow for one command.
 *
 * Returns `undefined` when the handler completed synchronously and a
 * Promise when we are still awaiting user work, so the concurrency
 * limiter can skip `.finally()` allocation on the sync path.
 *
 * The deadline `setTimeout` is only armed on the async branch: sync
 * handlers cannot miss the deadline they return inside, so registering
 * a timer just to clear it microseconds later is wasted work.
 */
export const createRpcPipeline = (rctx: RpcPipelineContext): RouteFn => {
  const { eventBus, logger, timeout, ackExtension, otel, serviceName, serverEndpoint } = rctx;
  const { publishReply, publishErrorReply } = createRepliers(rctx);
  const resolveCommand = createCommandResolver(rctx);
  const reportHandlerCompleted = createHandlerReporter(
    eventBus,
    rctx.patternRegistry,
    StreamKind.Command,
  );

  const emitRpcTimeout = (subject: string, correlationId: string): void => {
    eventBus.emit(TransportEvent.RpcTimeout, subject, correlationId);
  };

  return (msg: JsMsg): Promise<void> | undefined => {
    const resolved = resolveCommand(msg);

    if (resolved === null) return undefined;

    const { handler, data, replyTo, correlationId } = resolved;
    const subject = msg.subject;
    const ctx = new RpcContext([msg]);
    const stopAckExtension = startAckExtensionTimer(msg, ackExtension);
    const startedAt = performance.now();

    const reportHandlerError = (err: unknown): void => {
      eventBus.emit(TransportEvent.Error, toError(err), `rpc-handler:${subject}`);
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
      publishReply(replyTo, correlationId, pending, subject);
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
      // RpcTimeout hook is the canonical signal here and carries the report alone.
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
        publishReply(replyTo, correlationId, result, subject);
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
};
