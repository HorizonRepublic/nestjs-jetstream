import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Span,
} from '@opentelemetry/api';
import type { DeliveryInfo } from '@nats-io/jetstream';

import { HOOK_CONSUME, HOOK_RESPONSE, SPAN_NAME_PROCESS } from '../attribute-keys';
import { applyExpectedErrorAttributes, buildConsumeAttributes } from '../attributes';
import { captureBodyAttribute, captureMatchingHeaders } from '../capture';
import { hdrsGetter } from '../carrier';
import type {
  ConsumeKind,
  ConsumeSourceMsg,
  HandlerMetadata,
  ResolvedOtelOptions,
  ServerEndpoint,
} from '../config';
import { safelyInvokeHook } from '../internal-utils';
import { extractContext } from '../propagator';
import { getTracer } from '../tracer';
import { JetstreamTrace } from '../trace-kinds';

const isPromiseLike = <T>(value: unknown): value is PromiseLike<T> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PromiseLike<T>).then === 'function';

export interface ConsumeSpanContext {
  readonly subject: string;
  readonly pattern?: string;
  readonly msg: ConsumeSourceMsg;
  /** JetStream delivery metadata; absent for Core RPC paths. */
  readonly info?: DeliveryInfo;
  readonly kind: ConsumeKind;
  readonly payloadBytes: number;
  readonly handlerMetadata: HandlerMetadata;
  readonly serviceName: string;
  readonly endpoint: ServerEndpoint | null;
}

/**
 * Optional knobs the RPC router uses to end the CONSUMER span early when
 * its own deadline fires. The handler's Promise may still be pending in
 * that case — the span status reflects the RPC outcome, not the
 * handler's eventual settlement.
 */
export interface ConsumeSpanOptions {
  /**
   * When aborted, the span is finalized with status ERROR and an
   * `rpc.timeout`-like event. Subsequent handler resolution / rejection
   * is ignored (the span is idempotent after the first finish).
   */
  readonly signal?: AbortSignal;
  /**
   * Label attached to the timeout event / status message when `signal`
   * fires. Defaults to `'handler.timeout'`.
   */
  readonly timeoutLabel?: string;
}

const applyExpectedError = (span: Span, err: unknown): void => {
  span.setStatus({ code: SpanStatusCode.OK });
  applyExpectedErrorAttributes(span, err);
};

const applyUnexpectedError = (span: Span, err: unknown): void => {
  const error = err instanceof Error ? err : new Error(String(err));

  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
};

/**
 * Wrap a handler invocation in a CONSUMER span whose parent comes from the
 * incoming message headers. Preserves the caller's sync-vs-async result
 * shape — sync handlers return sync, async handlers return a Promise.
 *
 * Fast paths:
 * - `otel.enabled: false` → run `fn` directly, no span, no context extract
 *   (full kill switch).
 * - `traces` excludes `Consume` or `shouldTraceConsume` returns false →
 *   still extract the parent from headers and run `fn` under that context
 *   so the host app's tracer sees the right parent, but no span is created.
 *
 * Thrown errors go through `config.errorClassifier`: expected → status OK
 * with `jetstream.rpc.reply.*` attrs; unexpected → status ERROR with
 * `recordException`. The error rethrows, so the caller's settlement logic
 * (nak / term / DLQ) runs unchanged.
 */
export const withConsumeSpan = <T>(
  ctx: ConsumeSpanContext,
  config: ResolvedOtelOptions,
  fn: () => T | Promise<T>,
  options: ConsumeSpanOptions = {},
): T | Promise<T> => {
  if (!config.enabled) return fn();

  const parentCtx = extractContext(ROOT_CONTEXT, ctx.msg.headers, hdrsGetter);

  const shouldCreateSpan =
    config.traces.has(JetstreamTrace.Consume) &&
    (config.shouldTraceConsume?.(ctx.subject, ctx.msg) ?? true);

  if (!shouldCreateSpan) {
    return context.with(parentCtx, fn);
  }

  const tracer = getTracer();
  const span = tracer.startSpan(
    `${SPAN_NAME_PROCESS} ${ctx.subject}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        ...buildConsumeAttributes({
          subject: ctx.subject,
          pattern: ctx.pattern,
          msg: ctx.msg,
          info: ctx.info,
          kind: ctx.kind,
          payloadBytes: ctx.payloadBytes,
          serviceName: ctx.serviceName,
          serverAddress: ctx.endpoint?.host,
          serverPort: ctx.endpoint?.port,
        }),
        ...captureMatchingHeaders(ctx.msg.headers, config.captureHeaders),
        ...captureBodyAttribute(ctx.subject, ctx.msg.data, config.captureBody),
      },
    },
    parentCtx,
  );

  safelyInvokeHook(HOOK_CONSUME, config.consumeHook, span, {
    subject: ctx.subject,
    msg: ctx.msg,
    handlerMetadata: ctx.handlerMetadata,
    kind: ctx.kind,
  });

  const ctxWithSpan = trace.setSpan(parentCtx, span);
  const start = Date.now();
  let finalized = false;

  const finishOk = (): void => {
    if (finalized) return;
    finalized = true;
    span.setStatus({ code: SpanStatusCode.OK });
    safelyInvokeHook(HOOK_RESPONSE, config.responseHook, span, {
      subject: ctx.subject,
      durationMs: Date.now() - start,
    });
    span.end();
  };

  const finishError = (err: unknown): void => {
    if (finalized) return;
    finalized = true;
    if (config.errorClassifier(err) === 'expected') {
      applyExpectedError(span, err);
    } else {
      applyUnexpectedError(span, err);
    }

    safelyInvokeHook(HOOK_RESPONSE, config.responseHook, span, {
      subject: ctx.subject,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    span.end();
  };

  // External abort: the RPC router wires its own deadline here so the
  // span closes even when the handler never settles. The handler's
  // eventual resolution / rejection is still observed below but becomes
  // a no-op — `finishOk` / `finishError` respect the `finalized` flag.
  const { signal, timeoutLabel = 'handler.timeout' } = options;
  const onAbort = (): void => {
    if (finalized) return;
    const error = new Error(timeoutLabel);

    span.addEvent(timeoutLabel);
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: timeoutLabel });
    safelyInvokeHook(HOOK_RESPONSE, config.responseHook, span, {
      subject: ctx.subject,
      durationMs: Date.now() - start,
      error,
    });
    finalized = true;
    span.end();
  };

  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let result: T | Promise<T>;

  try {
    result = context.with(ctxWithSpan, fn);
  } catch (err) {
    finishError(err);
    throw err;
  }

  if (isPromiseLike<T>(result)) {
    return Promise.resolve(result).then(
      (value) => {
        finishOk();

        return value;
      },
      (err: unknown) => {
        finishError(err);

        throw err;
      },
    );
  }

  finishOk();

  return result;
};
