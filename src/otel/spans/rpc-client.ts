import { SpanKind, SpanStatusCode, context, trace, type Context } from '@opentelemetry/api';
import type { MsgHdrs } from '@nats-io/transport-node';

import { HOOK_RESPONSE, SPAN_NAME_SEND } from '../attribute-keys';
import { applyExpectedErrorAttributes, buildRpcClientAttributes } from '../attributes';
import { captureBodyAttribute, captureMatchingHeaders } from '../capture';
import { hdrsSetter } from '../carrier';
import type { ResolvedOtelOptions, ServerEndpoint } from '../config';
import { safelyInvokeHook } from '../internal-utils';
import { injectContext } from '../propagator';
import { getTracer } from '../tracer';
import { JetstreamTrace } from '../trace-kinds';

export interface RpcClientSpanContext {
  readonly subject: string;
  readonly pattern?: string;
  /** Optional in Core RPC (NATS request/reply uses an internal muxer). */
  readonly correlationId?: string;
  readonly payloadBytes: number;
  readonly payload: Uint8Array;
  readonly messageId?: string;
  readonly headers: MsgHdrs;
  readonly serviceName: string;
  readonly endpoint: ServerEndpoint | null;
}

/**
 * Discriminant for {@link RpcOutcome} variants. Constants instead of string
 * literals so call sites reference a named member and renames surface as
 * compile errors.
 */
export enum RpcOutcomeKind {
  /** Reply received with no error flag — plain success. */
  Ok = 'ok',
  /** Reply received with `x-error: true` — structured business error, span stays OK. */
  ReplyError = 'reply-error',
  /** Round-trip exceeded the configured timeout. Span status ERROR, `rpc.timeout` message. */
  Timeout = 'timeout',
  /** Any other failure during the round-trip (publish reject, connection drop, decode, …). Span status ERROR + recordException. */
  Error = 'error',
}

/** Message used on the span event, status, and the raised `Error` for a timed-out RPC. */
export const RPC_TIMEOUT_MESSAGE = 'rpc.timeout';

/**
 * Outcome of an RPC round-trip from the caller's point of view. Translated
 * by the helper into span status + attributes.
 */
export type RpcOutcome =
  | { readonly kind: RpcOutcomeKind.Ok; readonly reply: unknown }
  | { readonly kind: RpcOutcomeKind.ReplyError; readonly replyPayload: unknown }
  | { readonly kind: RpcOutcomeKind.Timeout }
  | { readonly kind: RpcOutcomeKind.Error; readonly error: Error };

/**
 * Handle returned by {@link beginRpcClientSpan}. The caller invokes
 * `finish(outcome)` exactly once when the RPC round-trip completes and
 * wraps the request/await in `context.with(activeContext, fn)` so any
 * spans the host app creates during the round-trip nest under this span.
 * When the trace kind is disabled or OTel is off, `activeContext` is the
 * currently-active context — `context.with` is safe to call regardless.
 */
export interface RpcClientSpanHandle {
  readonly activeContext: Context;
  finish(outcome: RpcOutcome): void;
}

/**
 * Wrap an RPC round-trip (`client.send`) in a CLIENT span. Returns a
 * `finish(outcome)` handle the caller invokes once — on reply, timeout, or
 * transport failure — and that's when the span ends.
 *
 * `x-error: true` replies are expected business outcomes (span OK +
 * `jetstream.rpc.reply.*`). Real transport failures (timeout, connection
 * drop, publish reject) mark the span ERROR.
 *
 * Fast paths:
 * - `otel.enabled: false` → no span, no propagation (full kill switch).
 * - `traces` excludes `RpcClientSend` → no span, but the active context is
 *   still injected so downstream consumers keep the trace chain.
 */
export const beginRpcClientSpan = (
  ctx: RpcClientSpanContext,
  config: ResolvedOtelOptions,
): RpcClientSpanHandle => {
  // Kill switch — `otel.enabled: false` opts out of propagation too.
  if (!config.enabled) {
    return {
      activeContext: context.active(),
      finish: () => undefined,
    };
  }

  if (!config.traces.has(JetstreamTrace.RpcClientSend)) {
    // Span suppressed but trace context still propagates so downstream consumers stay linked.
    injectContext(context.active(), ctx.headers, hdrsSetter);

    return {
      activeContext: context.active(),
      finish: () => undefined,
    };
  }

  const tracer = getTracer();
  const span = tracer.startSpan(`${SPAN_NAME_SEND} ${ctx.subject}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      ...buildRpcClientAttributes({
        subject: ctx.subject,
        pattern: ctx.pattern,
        correlationId: ctx.correlationId,
        payloadBytes: ctx.payloadBytes,
        messageId: ctx.messageId,
        serviceName: ctx.serviceName,
        serverAddress: ctx.endpoint?.host,
        serverPort: ctx.endpoint?.port,
      }),
      ...captureMatchingHeaders(ctx.headers, config.captureHeaders),
      ...captureBodyAttribute(ctx.subject, ctx.payload, config.captureBody),
    },
  });

  const ctxWithSpan = trace.setSpan(context.active(), span);

  injectContext(ctxWithSpan, ctx.headers, hdrsSetter);
  // publishHook deliberately skipped — this is a CLIENT round-trip span, not a PRODUCER span.
  const start = Date.now();
  let finalized = false;

  const finish = (outcome: RpcOutcome): void => {
    if (finalized) return;
    finalized = true;

    let reply: unknown;
    let error: Error | undefined;

    switch (outcome.kind) {
      case RpcOutcomeKind.Ok:
        reply = outcome.reply;
        span.setStatus({ code: SpanStatusCode.OK });
        break;
      case RpcOutcomeKind.ReplyError:
        reply = outcome.replyPayload;
        applyExpectedErrorAttributes(span, outcome.replyPayload);
        span.setStatus({ code: SpanStatusCode.OK });
        break;
      case RpcOutcomeKind.Timeout:
        error = new Error(RPC_TIMEOUT_MESSAGE);
        span.addEvent(RPC_TIMEOUT_MESSAGE);
        span.setStatus({ code: SpanStatusCode.ERROR, message: RPC_TIMEOUT_MESSAGE });
        break;
      case RpcOutcomeKind.Error:
        error = outcome.error;
        span.recordException(outcome.error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.error.message });
        break;
      default: {
        const _exhaustive: never = outcome;

        throw new Error(`Unhandled RPC outcome: ${_exhaustive as string}`);
      }
    }

    safelyInvokeHook(HOOK_RESPONSE, config.responseHook, span, {
      subject: ctx.subject,
      durationMs: Date.now() - start,
      reply,
      error,
    });
    span.end();
  };

  return { activeContext: ctxWithSpan, finish };
};
