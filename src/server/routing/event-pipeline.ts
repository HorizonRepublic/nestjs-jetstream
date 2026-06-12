import type { MessageHandler } from '@nestjs/microservices';
import type { JsMsg } from '@nats-io/jetstream';

import { RpcContext } from '../../context';
import { MessageKind, TransportEvent } from '../../interfaces';
import { isPromiseLike, startAckExtensionTimer, unwrapResult } from '../../utils';
import { withConsumeSpan } from '../../otel';

import type { DeadLetterCapture } from './dead-letter-capture';
import { createSettlement, statusForContext } from './settlement';
import type { HandlerReporter, RoutePipelineContext } from './routing.types';

/** Routing shape resolved for one incoming message. */
interface ResolvedEvent {
  readonly handler: MessageHandler;
  readonly data: unknown;
}

/**
 * Reports handler completion to the event bus using the declared pattern
 * (not the wire subject) so metric cardinality stays bounded. hasHook is
 * checked per-emit, not snapshotted, so late subscribers (e.g. the metrics
 * service bootstrapping after this router starts) still receive events.
 */
const createHandlerReporter = (rctx: RoutePipelineContext): HandlerReporter => {
  const { eventBus, patternRegistry, kind } = rctx;

  return (msg, startedAt, status) => {
    if (!eventBus.hasHook(TransportEvent.HandlerCompleted)) return;

    const declared = patternRegistry.resolveDeclared(msg.subject);
    const pattern = declared?.pattern ?? msg.subject;
    const declaredKind = declared?.kind ?? kind;
    const durationMs = performance.now() - startedAt;

    eventBus.emit(TransportEvent.HandlerCompleted, pattern, declaredKind, durationMs, status);
  };
};

/**
 * Resolves an incoming message to its handler and decoded payload. Returns
 * `null` when the message was settled synchronously (unroutable, no
 * dead-letter config) and a Promise while an unroutable one is captured.
 */
const createEventResolver = (
  rctx: RoutePipelineContext,
): ((msg: JsMsg) => ResolvedEvent | Promise<void> | null) => {
  const { patternRegistry, codec, eventBus, logger, capture, kind } = rctx;

  // Unroutable messages can't be fixed by redelivery, so capture them
  // immediately; term() on a workqueue stream would delete the payload.
  const captureUnroutable = (
    activeCapture: DeadLetterCapture,
    msg: JsMsg,
    err: Error,
  ): Promise<void> => {
    let data: unknown;

    try {
      data = codec.decode(msg.data);
    } catch {
      data = undefined;
    }

    return activeCapture.capture(msg, data, err).catch((captureErr: unknown) => {
      logger.error(`Dead-letter capture failed for unroutable ${msg.subject}:`, captureErr);
    });
  };

  return (msg) => {
    const subject = msg.subject;

    try {
      const handler = patternRegistry.getHandler(subject);

      if (!handler) {
        logger.error(`No handler for subject: ${subject}`);

        if (capture !== null) {
          return captureUnroutable(capture, msg, new Error(`No handler for event: ${subject}`));
        }

        msg.term(`No handler for event: ${subject}`);

        return null;
      }

      let data: unknown;

      try {
        data = codec.decode(msg.data);
      } catch (err) {
        logger.error(`Decode error for ${subject}:`, err);

        if (capture !== null) {
          return captureUnroutable(
            capture,
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

      // Terminate so NATS does not redeliver into the same synchronous
      // failure forever. term() itself may throw when the connection is
      // degraded; swallow that to keep the subscription alive.
      try {
        msg.term('Unexpected router error');
      } catch (termErr) {
        logger.error(`Failed to terminate message ${subject}:`, termErr);
      }

      return null;
    }
  };
};

/**
 * Build the routing pipeline for workqueue and broadcast streams.
 *
 * The returned function runs the full flow for one message and returns
 * `undefined` when it completed synchronously (sync handler, no awaitable
 * settlement) so the concurrency gate can skip the `.finally()` allocation
 * on the sync path.
 */
export const createWorkqueuePipeline = (
  rctx: RoutePipelineContext,
): ((msg: JsMsg) => Promise<void> | undefined) => {
  const { kind, spanKind, logger, eventBus, otel, serviceName, serverEndpoint } = rctx;
  const { ackExtensionInterval } = rctx;
  const hasAckExtension = ackExtensionInterval !== null && ackExtensionInterval > 0;

  const reportHandlerCompleted = createHandlerReporter(rctx);
  const resolveEvent = createEventResolver(rctx);
  const { settleSuccess, settleFailure } = createSettlement(logger, rctx.capture);

  return (msg) => {
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

      // Keep the ack extension alive across settleFailure(): it may route
      // through the dead-letter capture whose JetStream publish can take
      // longer than the consumer's ack_wait. Stopping early would let NATS
      // redeliver mid-DLQ-publish and double-fire onDeadLetter. Mirrors the
      // async branch below.
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

      // The dead-letter publish may outlast ack_wait; keep the extension alive.
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
};

/**
 * Build the routing pipeline for ordered streams: no settlement (ordered
 * consumers auto-acknowledge), no dead-letter escalation, strictly
 * sequential delivery enforced by the concurrency gate.
 */
export const createOrderedPipeline = (
  rctx: RoutePipelineContext,
): ((msg: JsMsg) => Promise<void> | undefined) => {
  const { spanKind, codec, logger, eventBus, patternRegistry, otel } = rctx;
  const { serviceName, serverEndpoint } = rctx;

  const reportHandlerCompleted = createHandlerReporter(rctx);

  return (msg) => {
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
          `retry()/terminate() ignored for ordered message ${subject}; ordered consumers auto-acknowledge`,
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
};
