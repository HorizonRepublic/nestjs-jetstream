import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { MsgHdrs } from '@nats-io/transport-node';

import type { JetstreamRecord } from '../../client';
import {
  ATTR_JETSTREAM_SCHEDULE_TARGET,
  HOOK_PUBLISH,
  HOOK_RESPONSE,
  SPAN_NAME_PUBLISH,
} from '../attribute-keys';
import { buildPublishAttributes } from '../attributes';
import { captureBodyAttribute, captureMatchingHeaders } from '../capture';
import { hdrsSetter } from '../carrier';
import type { PublishKind, ResolvedOtelOptions, ServerEndpoint } from '../config';
import { safelyInvokeHook } from '../internal-utils';
import { injectContext } from '../propagator';
import { getTracer } from '../tracer';
import { JetstreamTrace } from '../trace-kinds';

/**
 * Input required to build a publish span. The caller (JetstreamClient)
 * supplies resolved subject, pattern, and the runtime payload/header info.
 */
export interface PublishSpanContext {
  readonly subject: string;
  readonly pattern?: string;
  readonly record: JetstreamRecord;
  readonly kind: PublishKind;
  readonly payloadBytes: number;
  readonly payload: Uint8Array;
  readonly messageId?: string;
  readonly correlationId?: string;
  readonly headers: MsgHdrs;
  readonly serviceName: string;
  readonly endpoint: ServerEndpoint | null;
  /**
   * Logical delivery target when the message is a scheduled publish. When
   * set, `subject` is the physical `_sch.*` subject NATS is publishing to and
   * `scheduleTarget` is the subject the broker will redeliver it on. Surfaced
   * as `jetstream.schedule.target` so APM subject filters match the consumer
   * side of the trace.
   */
  readonly scheduleTarget?: string;
}

/**
 * Wrap an outgoing publish operation in a `PRODUCER` span. Injects the
 * active trace context into the outgoing headers so downstream consumers
 * continue the trace. Publish failures are always recorded as span
 * errors (infrastructure failure, not a business outcome).
 *
 * Fast paths:
 * - `otel.enabled: false` → run `fn` with no span, no header injection
 * - `traces` set does not include `Publish` → inject propagation only
 * - `shouldTracePublish` returns false → inject propagation only
 */
export const withPublishSpan = async <T>(
  ctx: PublishSpanContext,
  config: ResolvedOtelOptions,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!config.enabled) return fn();

  // Even when we skip span creation we still want to propagate the ambient
  // trace context so downstream consumers remain linked to whatever is currently active.
  const shouldCreateSpan =
    config.traces.has(JetstreamTrace.Publish) &&
    (config.shouldTracePublish?.(ctx.subject, ctx.record) ?? true);

  if (!shouldCreateSpan) {
    injectContext(context.active(), ctx.headers, hdrsSetter);

    return fn();
  }

  const tracer = getTracer();
  const span = tracer.startSpan(`${SPAN_NAME_PUBLISH} ${ctx.subject}`, {
    kind: SpanKind.PRODUCER,
    attributes: {
      ...buildPublishAttributes({
        subject: ctx.subject,
        pattern: ctx.pattern,
        serviceName: ctx.serviceName,
        serverAddress: ctx.endpoint?.host,
        serverPort: ctx.endpoint?.port,
        kind: ctx.kind,
        payloadBytes: ctx.payloadBytes,
        messageId: ctx.messageId,
        correlationId: ctx.correlationId,
      }),
      ...(ctx.scheduleTarget ? { [ATTR_JETSTREAM_SCHEDULE_TARGET]: ctx.scheduleTarget } : {}),
      ...captureMatchingHeaders(ctx.headers, config.captureHeaders),
      ...captureBodyAttribute(ctx.subject, ctx.payload, config.captureBody),
    },
  });

  const ctxWithSpan = trace.setSpan(context.active(), span);

  injectContext(ctxWithSpan, ctx.headers, hdrsSetter);
  safelyInvokeHook(HOOK_PUBLISH, config.publishHook, span, {
    subject: ctx.subject,
    record: ctx.record,
    kind: ctx.kind,
  });

  const start = Date.now();

  try {
    const result = await context.with(ctxWithSpan, fn);

    span.setStatus({ code: SpanStatusCode.OK });
    safelyInvokeHook(HOOK_RESPONSE, config.responseHook, span, {
      subject: ctx.subject,
      durationMs: Date.now() - start,
    });

    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    safelyInvokeHook(HOOK_RESPONSE, config.responseHook, span, {
      subject: ctx.subject,
      durationMs: Date.now() - start,
      error,
    });

    throw err;
  } finally {
    span.end();
  }
};
