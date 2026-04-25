import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { JsMsg } from '@nats-io/jetstream';

import { HOOK_RESPONSE, SPAN_NAME_DEAD_LETTER } from '../attribute-keys';
import { buildDeadLetterAttributes } from '../attributes';
import { hdrsGetter } from '../carrier';
import type { ResolvedOtelOptions, ServerEndpoint } from '../config';
import { safelyInvokeHook } from '../internal-utils';
import { extractContext } from '../propagator';
import { getTracer } from '../tracer';
import { JetstreamTrace } from '../trace-kinds';

export interface DeadLetterSpanContext {
  readonly msg: JsMsg;
  readonly pattern?: string;
  readonly finalDeliveryCount: number;
  readonly reason?: string;
  readonly serviceName: string;
  readonly endpoint: ServerEndpoint | null;
}

/**
 * Wrap the dead-letter fallback in an INTERNAL span. The span parents to
 * the original publish via the message's traceparent, so it sits as a
 * sibling of the failed Consume spans and the whole failure chain is
 * visible in one APM waterfall. Span duration captures the real fallback
 * cost — `onDeadLetter` callback, DLQ republish, event bus emit.
 */
export const withDeadLetterSpan = async <T>(
  ctx: DeadLetterSpanContext,
  config: ResolvedOtelOptions,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!config.enabled || !config.traces.has(JetstreamTrace.DeadLetter)) {
    return fn();
  }

  const parentCtx = extractContext(ROOT_CONTEXT, ctx.msg.headers, hdrsGetter);
  const tracer = getTracer();
  const span = tracer.startSpan(
    `${SPAN_NAME_DEAD_LETTER} ${ctx.msg.subject}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: buildDeadLetterAttributes({
        subject: ctx.msg.subject,
        pattern: ctx.pattern,
        serviceName: ctx.serviceName,
        serverAddress: ctx.endpoint?.host,
        serverPort: ctx.endpoint?.port,
        finalDeliveryCount: ctx.finalDeliveryCount,
        reason: ctx.reason,
      }),
    },
    parentCtx,
  );

  const ctxWithSpan = trace.setSpan(parentCtx, span);
  const start = Date.now();
  const invokeResponseHook = (error?: Error): void => {
    // Run inside the span's active context so hooks that create child
    // spans see this dead-letter span as the parent.
    context.with(ctxWithSpan, () => {
      safelyInvokeHook(HOOK_RESPONSE, config.responseHook, span, {
        subject: ctx.msg.subject,
        durationMs: Date.now() - start,
        error,
      });
    });
  };

  try {
    const result = await context.with(ctxWithSpan, fn);

    span.setStatus({ code: SpanStatusCode.OK });
    invokeResponseHook();

    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    invokeResponseHook(error);

    throw err;
  } finally {
    span.end();
  }
};
