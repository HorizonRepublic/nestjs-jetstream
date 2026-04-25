import type { Span } from '@opentelemetry/api';
import type { MsgHdrs } from '@nats-io/transport-node';

import type { JetstreamRecord } from '../client';

import { compileHeaderAllowlist } from './capture';
import { DEFAULT_TRACES, JetstreamTrace } from './trace-kinds';

/** Tag attached to every outgoing publish span so consumers can distinguish event / RPC / broadcast / ordered flows. */
export enum PublishKind {
  Event = 'event',
  RpcRequest = 'rpc.request',
  Broadcast = 'broadcast',
  Ordered = 'ordered',
}

/** Tag attached to every incoming consume span. `Rpc` covers both Core and JetStream RPC handlers. */
export enum ConsumeKind {
  Event = 'event',
  Rpc = 'rpc',
  Broadcast = 'broadcast',
  Ordered = 'ordered',
}

/**
 * Handler metadata for the dispatched message. `pattern` is always set;
 * `className` / `methodName` come from NestJS reflection when available.
 */
export interface HandlerMetadata {
  readonly pattern: string;
  readonly className?: string;
  readonly methodName?: string;
}

/**
 * Host / port pair surfaced as `server.address` / `server.port` span
 * attributes. `port` is optional — OTel semconv makes it conditional on
 * being different from the protocol default, and we'd rather emit nothing
 * than invent a number the user never configured.
 */
export interface ServerEndpoint {
  readonly host: string;
  readonly port?: number;
}

/**
 * Minimum message shape the consume span helper requires. Both `JsMsg`
 * (JetStream) and Core NATS `Msg` satisfy it structurally; JetStream-only
 * delivery metadata (`info`) is read separately and omitted on the Core
 * RPC path.
 */
export interface ConsumeSourceMsg {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly headers?: MsgHdrs;
}

/** Context passed to {@link OtelOptions.publishHook} for an outgoing publish. */
export interface JetstreamPublishContext {
  /** Fully-resolved subject the message is being published to. */
  readonly subject: string;

  /** The record being published (payload, headers, builder-supplied options). */
  readonly record: JetstreamRecord;

  /** Classification of the outgoing operation. */
  readonly kind: PublishKind;
}

/** Context passed to {@link OtelOptions.consumeHook} for an incoming dispatch. */
export interface JetstreamConsumeContext {
  /** Fully-resolved subject of the incoming message. */
  readonly subject: string;

  /**
   * The incoming NATS message. JetStream messages (events, broadcast,
   * ordered, JetStream RPC) satisfy `JsMsg`; Core RPC messages satisfy
   * the looser {@link ConsumeSourceMsg} shape only. Narrow on `kind` to
   * decide which fields are safe to access.
   */
  readonly msg: ConsumeSourceMsg;

  /** Handler metadata; see {@link HandlerMetadata}. */
  readonly handlerMetadata: HandlerMetadata;

  /** Classification of the incoming operation. */
  readonly kind: ConsumeKind;
}

/** Context passed to {@link OtelOptions.responseHook} once an outcome is known, just before the span ends. */
export interface JetstreamResponseContext {
  /** Subject the operation targeted. */
  readonly subject: string;

  /** Wall-clock duration of the operation in milliseconds. */
  readonly durationMs: number;

  /** Decoded reply payload for RPC client spans when available. */
  readonly reply?: unknown;

  /** Error instance if the operation failed. */
  readonly error?: Error;
}

/**
 * Classification outcome for a thrown error. Affects span status and
 * attributes only — reply envelopes and internal logging are unchanged.
 */
export type ErrorClassification = 'expected' | 'unexpected';

/** Object form of {@link OtelOptions.captureBody}. */
export interface CaptureBodyOptions {
  /**
   * Maximum number of bytes to capture. Payloads longer than this are
   * truncated; a `messaging.nats.message.body.truncated` attribute is
   * added to indicate truncation occurred.
   *
   * @default 4096
   */
  readonly maxBytes?: number;

  /**
   * Only capture body for subjects matching these glob patterns. Each
   * pattern supports `*` wildcards and an optional leading `!` for
   * exclusion. When omitted, body capture applies to all subjects.
   */
  readonly subjectAllowlist?: readonly string[];
}

/**
 * OpenTelemetry configuration for `JetstreamModule.forRoot({ otel: … })`.
 * All fields are optional; when the host app has not registered an OTel
 * SDK, every call made by the library is a no-op regardless of config.
 */
export interface OtelOptions {
  /**
   * Global kill switch. When `false`, no spans are emitted, no propagation
   * is attempted, and no hooks fire.
   *
   * @default true
   */
  readonly enabled?: boolean;

  /**
   * Which trace kinds to emit.
   *
   * - `'default'` — publish, consume, RPC client round-trip, dead letter
   * - `'all'` — every trace kind defined in {@link JetstreamTrace}
   * - `'none'` — emit no spans at all (useful with `enabled: true` for
   *   pure trace-context propagation without the span overhead)
   * - `JetstreamTrace[]` — explicit selection
   *
   * @default 'default'
   */
  readonly traces?: readonly JetstreamTrace[] | 'default' | 'all' | 'none';

  /**
   * Header names to capture as span attributes (`messaging.header.<name>`).
   * Match is case-insensitive. Glob wildcards (`*`) and negation (`!prefix-*`)
   * are supported in the per-pattern form.
   *
   * SECURITY / GDPR: headers may contain authentication tokens, session
   * identifiers, or other sensitive data. Captured values are exported to
   * the configured OTel backend. Use an explicit allowlist in production.
   * Setting this to `true` captures every header and is intended for
   * development environments only.
   *
   * Transport-internal headers (`x-correlation-id`, `x-reply-to`, `x-error`,
   * `x-subject`, `x-caller-name`) and propagator-owned headers
   * (`traceparent`, `tracestate`, `baggage`, `sentry-trace`, `b3`, …) are
   * always suppressed regardless of the allowlist.
   *
   * @default ['x-request-id']
   */
  readonly captureHeaders?: readonly string[] | boolean;

  /**
   * Capture the message payload as the `messaging.nats.message.body` span
   * attribute. Defaults to `false` for privacy and cost reasons.
   *
   * Passing `true` captures up to 4 KiB per message. Use the object form
   * for finer control over size and subject scope.
   *
   * SECURITY / GDPR: payloads commonly contain PII, credentials, financial
   * data, or content regulated by HIPAA / PCI-DSS. Enabling body capture
   * in production is almost always a policy violation. Prefer enabling
   * only in development, or pair with a custom `SpanProcessor` that
   * scrubs or drops the attribute before export.
   *
   * @default false
   */
  readonly captureBody?: boolean | CaptureBodyOptions;

  /**
   * Invoked after a publish span has been started and before the actual
   * publish call executes. Use to enrich the span with custom attributes.
   * Must be synchronous — thrown errors are caught and logged at debug
   * level without affecting the publish path.
   */
  publishHook?(span: Span, ctx: JetstreamPublishContext): void;

  /**
   * Invoked after a consume span has been started and before the handler
   * is dispatched. Use to enrich the span with custom attributes derived
   * from the incoming message or handler metadata.
   */
  consumeHook?(span: Span, ctx: JetstreamConsumeContext): void;

  /**
   * Invoked once an operation's outcome is known (success, error, or
   * timeout) and the span status has been set, just before the span ends.
   * Fires for publish, consume, and RPC client spans.
   */
  responseHook?(span: Span, ctx: JetstreamResponseContext): void;

  /**
   * Predicate evaluated at the top of every outgoing publish. Returning
   * `false` skips span creation for that publish; propagation of trace
   * context through headers still occurs, so downstream consumers are
   * unaffected. Useful for suppressing noise from health-check or
   * internal-only subjects.
   */
  shouldTracePublish?(subject: string, record: JetstreamRecord): boolean;

  /**
   * Predicate evaluated at the top of every incoming message delivery.
   * Returning `false` skips span creation for that delivery; the handler
   * still executes normally and trace context is still extracted from
   * headers for downstream calls.
   */
  shouldTraceConsume?(subject: string, msg: ConsumeSourceMsg): boolean;

  /**
   * Classify a thrown error as `'expected'` (business error, part of the
   * RPC contract) or `'unexpected'` (infrastructure failure or bug). Drives
   * OpenTelemetry span status and attributes only.
   *
   * - `'expected'` → span status `OK` with `jetstream.rpc.reply.has_error`
   *   and `jetstream.rpc.reply.error.code` attributes
   * - `'unexpected'` → span status `ERROR` with `span.recordException(err)`
   *
   * Reply envelopes delivered to RPC clients are identical in both cases.
   * This classification affects only the observability artifact.
   *
   * The default recognizes NestJS-idiomatic primitives for business errors:
   * `RpcException` and `HttpException`. Teams with custom error hierarchies
   * override to recognize their own types.
   *
   * @example
   *   errorClassifier: (err) => {
   *     if (err instanceof MyDomainError) return 'expected';
   *     if (err?.code?.startsWith('BIZ_')) return 'expected';
   *     return 'unexpected';
   *   }
   */
  errorClassifier?(err: unknown): ErrorClassification;
}

/** Compiled form of the `captureHeaders` allowlist. */
export type HeaderMatcher = (name: string) => boolean;

/** Resolved config with defaults applied. Internal only. */
export interface ResolvedOtelOptions {
  readonly enabled: boolean;
  readonly traces: ReadonlySet<JetstreamTrace>;
  readonly captureHeaders: HeaderMatcher;
  readonly captureBody:
    | false
    | { readonly maxBytes: number; readonly subjectAllowlist?: readonly string[] };
  readonly publishHook?: OtelOptions['publishHook'];
  readonly consumeHook?: OtelOptions['consumeHook'];
  readonly responseHook?: OtelOptions['responseHook'];
  readonly shouldTracePublish?: OtelOptions['shouldTracePublish'];
  readonly shouldTraceConsume?: OtelOptions['shouldTraceConsume'];
  errorClassifier(err: unknown): ErrorClassification;
}

const DEFAULT_CAPTURE_HEADERS: readonly string[] = ['x-request-id'];
const DEFAULT_CAPTURE_BODY_MAX_BYTES = 4096;

/**
 * NestJS wraps a bare `throw new Error(...)` from a `@MessagePattern` handler
 * into `{ status: 'error', message: 'Internal server error' }` before it
 * reaches the consume-span catch block. Match the exact `status` / `message`
 * pair used by NestJS's internal error normalization — checking just the
 * shape (and not `keys.length === 2`) keeps the sentinel detection working
 * if NestJS extends the wrapper with extra diagnostic fields in a future
 * minor release.
 */
const NESTJS_BARE_ERROR_MESSAGE = 'Internal server error';

const isNestjsBareErrorSentinel = (obj: Record<string, unknown>): boolean =>
  obj.status === 'error' && obj.message === NESTJS_BARE_ERROR_MESSAGE;

/**
 * Default classifier. Recognizes `RpcException` / `HttpException` (and
 * subclasses) by prototype-chain walk so we stay a type-only dependency on
 * NestJS. Plain non-Error objects arriving at the catch path are almost
 * always `RpcException.getError()` output and count as expected; the only
 * exception is NestJS's "Internal server error" sentinel for bare throws.
 */
const defaultErrorClassifier = (err: unknown): ErrorClassification => {
  if (err === null || typeof err !== 'object') return 'unexpected';

  if (!(err instanceof Error)) {
    if (isNestjsBareErrorSentinel(err as Record<string, unknown>)) return 'unexpected';

    return 'expected';
  }

  // Walk the prototype chain starting from the instance itself so direct
  // `RpcException` / `HttpException` throws and deeper subclasses
  // (`NotFoundException extends HttpException`, …) match uniformly.
  let proto: object | null = err;

  while (proto) {
    const name = (proto as { constructor?: { name?: string } }).constructor?.name;

    if (name === 'RpcException' || name === 'HttpException') return 'expected';
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  return 'unexpected';
};

const expandTracesOption = (option: OtelOptions['traces']): ReadonlySet<JetstreamTrace> => {
  if (option === undefined || option === 'default') return new Set(DEFAULT_TRACES);
  if (option === 'all') return new Set(Object.values(JetstreamTrace));
  if (option === 'none') return new Set();

  return new Set(option);
};

const compileHeaderMatcher = (option: OtelOptions['captureHeaders']): HeaderMatcher =>
  compileHeaderAllowlist(option ?? DEFAULT_CAPTURE_HEADERS);

const resolveCaptureBody = (
  option: OtelOptions['captureBody'],
): ResolvedOtelOptions['captureBody'] => {
  if (option === undefined || option === false) return false;
  if (option === true) return { maxBytes: DEFAULT_CAPTURE_BODY_MAX_BYTES };

  return {
    maxBytes: option.maxBytes ?? DEFAULT_CAPTURE_BODY_MAX_BYTES,
    subjectAllowlist: option.subjectAllowlist,
  };
};

/**
 * Apply defaults to user-supplied OTel options. Called once at module
 * init. Hook / predicate types are enforced by TypeScript; runtime
 * validation would duplicate what the compiler already checks and isn't
 * this layer's job — the NestJS / NATS infra above us owns config
 * integrity.
 */
export const resolveOtelOptions = (options: OtelOptions = {}): ResolvedOtelOptions => {
  return {
    enabled: options.enabled ?? true,
    traces: expandTracesOption(options.traces),
    captureHeaders: compileHeaderMatcher(options.captureHeaders),
    captureBody: resolveCaptureBody(options.captureBody),
    publishHook: options.publishHook,
    consumeHook: options.consumeHook,
    responseHook: options.responseHook,
    shouldTracePublish: options.shouldTracePublish,
    shouldTraceConsume: options.shouldTraceConsume,
    errorClassifier: options.errorClassifier ?? defaultErrorClassifier,
  };
};
