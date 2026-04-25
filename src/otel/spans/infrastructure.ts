import { Logger } from '@nestjs/common';
import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type AttributeValue,
  type Span,
} from '@opentelemetry/api';

import {
  ATTR_JETSTREAM_MIGRATION_REASON,
  ATTR_JETSTREAM_PROVISIONING_ACTION,
  ATTR_JETSTREAM_PROVISIONING_ENTITY,
  ATTR_JETSTREAM_PROVISIONING_NAME,
  ATTR_JETSTREAM_SELF_HEALING_REASON,
  ATTR_JETSTREAM_SERVICE_NAME,
  ATTR_MESSAGING_CONSUMER_GROUP_NAME,
  ATTR_MESSAGING_NATS_STREAM_NAME,
  ATTR_NATS_CONNECTION_SERVER,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  SPAN_NAME_JETSTREAM_MIGRATION,
  SPAN_NAME_JETSTREAM_PROVISIONING_PREFIX,
  SPAN_NAME_JETSTREAM_SELF_HEALING,
  SPAN_NAME_JETSTREAM_SHUTDOWN,
  SPAN_NAME_NATS_CONNECTION,
} from '../attribute-keys';
import type { ResolvedOtelOptions, ServerEndpoint } from '../config';
import { getTracer } from '../tracer';
import { JetstreamTrace } from '../trace-kinds';

const logger = new Logger('Jetstream:Otel');

/** Optional attribute map used by infrastructure span builders. */
type AttributeBag = Record<string, AttributeValue | undefined>;

/** Attributes accepted by {@link ConnectionLifecycleSpanHandle.recordEvent}. */
export type SpanEventAttributes = Record<string, AttributeValue>;

/** Service identity + endpoint shared by every infrastructure span, so APM dashboards can filter by deployment. */
export interface InfrastructureSpanContext {
  readonly serviceName: string;
  readonly endpoint: ServerEndpoint | null;
}

const startInfraSpan = (
  config: ResolvedOtelOptions,
  traceKind: JetstreamTrace,
  name: string,
  ctx: InfrastructureSpanContext,
  extraAttributes: AttributeBag = {},
): Span | null => {
  if (!config.enabled || !config.traces.has(traceKind)) return null;

  const tracer = getTracer();
  const attributes: Record<string, AttributeValue> = {
    [ATTR_JETSTREAM_SERVICE_NAME]: ctx.serviceName,
  };

  if (ctx.endpoint?.host) attributes[ATTR_SERVER_ADDRESS] = ctx.endpoint.host;
  if (ctx.endpoint?.port !== undefined) attributes[ATTR_SERVER_PORT] = ctx.endpoint.port;

  for (const [key, value] of Object.entries(extraAttributes)) {
    if (value !== undefined) attributes[key] = value;
  }

  return tracer.startSpan(name, { kind: SpanKind.INTERNAL, attributes });
};

const finishOk = (span: Span): void => {
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
};

const finishError = (span: Span, err: unknown): void => {
  const error = err instanceof Error ? err : new Error(String(err));

  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  span.end();
};

/**
 * Run `op` inside an INTERNAL span gated by a `JetstreamTrace` toggle. The
 * span is set as the active context for the operation so any nested OTel
 * work (NATS publishes, downstream HTTP, library spans) parents under it
 * instead of the ambient context. On throw the span is marked ERROR and
 * the error rethrows. When the toggle is off `op` runs directly with no
 * span and no context switch.
 */
const wrapInfra = async <T>(
  config: ResolvedOtelOptions,
  traceKind: JetstreamTrace,
  name: string,
  ctx: InfrastructureSpanContext,
  attributes: AttributeBag,
  op: () => Promise<T>,
): Promise<T> => {
  const span = startInfraSpan(config, traceKind, name, ctx, attributes);

  if (!span) return op();

  const ctxWithSpan = trace.setSpan(context.active(), span);

  try {
    const result = await context.with(ctxWithSpan, op);

    finishOk(span);

    return result;
  } catch (err) {
    finishError(span, err);
    throw err;
  }
};

export interface ConnectionLifecycleSpanContext extends InfrastructureSpanContext {
  readonly server?: string;
}

/**
 * Handle for a `nats.connection` span covering one connection session. The
 * caller calls `recordEvent` / `finish` as the session progresses; when the
 * trace toggle is off all methods are no-ops.
 */
export interface ConnectionLifecycleSpanHandle {
  recordEvent(name: string, attributes?: SpanEventAttributes): void;
  finish(err?: unknown): void;
}

export const beginConnectionLifecycleSpan = (
  config: ResolvedOtelOptions,
  ctx: ConnectionLifecycleSpanContext,
): ConnectionLifecycleSpanHandle => {
  const span = startInfraSpan(
    config,
    JetstreamTrace.ConnectionLifecycle,
    SPAN_NAME_NATS_CONNECTION,
    ctx,
    { [ATTR_NATS_CONNECTION_SERVER]: ctx.server },
  );

  if (!span) {
    return {
      recordEvent: () => undefined,
      finish: () => undefined,
    };
  }

  let finalized = false;

  return {
    recordEvent: (name: string, attributes?: SpanEventAttributes): void => {
      if (finalized) {
        // A hook after `finish()` is a misuse — quiet debug log so libraries
        // that forward NestJS `debug` to APM can catch it in development.
        logger.debug(`recordEvent('${name}') called after connection span finished`);

        return;
      }

      span.addEvent(name, attributes);
    },
    finish: (err?: unknown): void => {
      if (finalized) return;
      finalized = true;
      if (err === undefined) finishOk(span);
      else finishError(span, err);
    },
  };
};

export interface SelfHealingSpanContext extends InfrastructureSpanContext {
  readonly consumer: string;
  readonly stream: string;
  readonly reason: string;
}

export const withSelfHealingSpan = <T>(
  config: ResolvedOtelOptions,
  ctx: SelfHealingSpanContext,
  op: () => Promise<T>,
): Promise<T> =>
  wrapInfra(
    config,
    JetstreamTrace.SelfHealing,
    SPAN_NAME_JETSTREAM_SELF_HEALING,
    ctx,
    {
      [ATTR_MESSAGING_NATS_STREAM_NAME]: ctx.stream,
      [ATTR_MESSAGING_CONSUMER_GROUP_NAME]: ctx.consumer,
      [ATTR_JETSTREAM_SELF_HEALING_REASON]: ctx.reason,
    },
    op,
  );

export type ProvisioningEntity = 'stream' | 'consumer';

export type ProvisioningAction = 'create' | 'update' | 'ensure' | 'recover';

export interface ProvisioningSpanContext extends InfrastructureSpanContext {
  readonly entity: ProvisioningEntity;
  readonly name: string;
  readonly action: ProvisioningAction;
}

export const withProvisioningSpan = <T>(
  config: ResolvedOtelOptions,
  ctx: ProvisioningSpanContext,
  op: () => Promise<T>,
): Promise<T> =>
  wrapInfra(
    config,
    JetstreamTrace.Provisioning,
    `${SPAN_NAME_JETSTREAM_PROVISIONING_PREFIX}${ctx.entity}`,
    ctx,
    {
      [ATTR_JETSTREAM_PROVISIONING_ENTITY]: ctx.entity,
      [ATTR_JETSTREAM_PROVISIONING_ACTION]: ctx.action,
      [ATTR_JETSTREAM_PROVISIONING_NAME]: ctx.name,
    },
    op,
  );

export interface MigrationSpanContext extends InfrastructureSpanContext {
  readonly stream: string;
  readonly reason: string;
}

export const withMigrationSpan = <T>(
  config: ResolvedOtelOptions,
  ctx: MigrationSpanContext,
  op: () => Promise<T>,
): Promise<T> =>
  wrapInfra(
    config,
    JetstreamTrace.Migration,
    SPAN_NAME_JETSTREAM_MIGRATION,
    ctx,
    {
      [ATTR_MESSAGING_NATS_STREAM_NAME]: ctx.stream,
      [ATTR_JETSTREAM_MIGRATION_REASON]: ctx.reason,
    },
    op,
  );

export const withShutdownSpan = <T>(
  config: ResolvedOtelOptions,
  ctx: InfrastructureSpanContext,
  op: () => Promise<T>,
): Promise<T> =>
  wrapInfra(config, JetstreamTrace.Shutdown, SPAN_NAME_JETSTREAM_SHUTDOWN, ctx, {}, op);
