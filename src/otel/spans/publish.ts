import { Logger } from '@nestjs/common';
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

const logger = new Logger('Jetstream:Otel');

/**
 * Evaluate `shouldTracePublish` defensively. A throwing user predicate
 * should never derail a publish — fail-open (assume "trace it") so a buggy
 * filter doesn't black-hole spans, and surface the failure at debug.
 */
const shouldTracePublishSafe = (
  predicate: ResolvedOtelOptions['shouldTracePublish'],
  subject: string,
  record: JetstreamRecord,
): boolean => {
  if (!predicate) return true;

  try {
    return predicate(subject, record);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    logger.debug(`OTel shouldTracePublish threw: ${message}`);

    return true;
  }
};

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

  const shouldCreateSpan =
    config.traces.has(JetstreamTrace.Publish) &&
    shouldTracePublishSafe(config.shouldTracePublish, ctx.subject, ctx.record);

  if (!shouldCreateSpan) {
    // Propagate the ambient context so downstream consumers stay linked even without a PRODUCER span.
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

  const start = Date.now();

  try {
    const result = await context.with(ctxWithSpan, async () => {
      // Fire publishHook inside the span's active context so any nested
      // OTel calls (`tracer.startSpan`, `trace.getActiveSpan`) parent under
      // this PRODUCER span instead of the ambient one.
      safelyInvokeHook(HOOK_PUBLISH, config.publishHook, span, {
        subject: ctx.subject,
        record: ctx.record,
        kind: ctx.kind,
      });

      return fn();
    });

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
