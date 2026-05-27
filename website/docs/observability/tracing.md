---
sidebar_position: 1
sidebar_label: "Distributed Tracing"
title: "Distributed Tracing — NestJS JetStream Transport"
description: "Built-in W3C Trace Context propagation and OpenTelemetry spans for every publish, consume, and RPC round-trip. Works zero-config with Sentry, Datadog, Jaeger, Tempo, Honeycomb, and any OTel-compatible APM."
schema:
  type: Article
  headline: "Distributed Tracing — NestJS JetStream Transport"
  description: "Built-in W3C Trace Context propagation and OpenTelemetry spans for every publish, consume, and RPC round-trip."
  datePublished: "2026-04-24"
  dateModified: "2026-05-27"
---

# Distributed Tracing

The transport produces OpenTelemetry spans for every publish, every consume, and every RPC round-trip. Trace context propagates through NATS message headers using the W3C Trace Context standard, so a single trace flows end-to-end across services regardless of language or runtime.

## Why this exists

Aggregate metrics tell you the system is slow; traces tell you _which_ message was slow and _where_ it spent its time. When a customer reports a failed order, you want a single waterfall view that follows the request from `client.emit('orders.created')` through every consumer, RPC hop, and dead-letter branch — across multiple services if needed. That's what tracing is for.

The library emits OpenTelemetry spans on the same paths the metrics surface counts. If you already run an APM (Sentry, Datadog, Honeycomb, Jaeger, Tempo, …), no transport-side configuration is required — traces appear the moment your application registers an OTel SDK.

## Setup

Tracing activates automatically the moment your application registers an OpenTelemetry SDK. **No transport-side configuration is required.** If no SDK is registered, the library's tracer calls are no-ops and there is zero runtime cost.

```ts
// tracing.ts — load this BEFORE your AppModule
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

new NodeSDK({
  serviceName: 'orders-service',
  traceExporter: new OTLPTraceExporter({ url: 'http://collector:4318/v1/traces' }),
}).start();
```

That's it. Spans appear in your backend immediately.

### Vendor cheat sheets

Every modern Node.js APM SDK ships with OpenTelemetry under the hood. Pick whichever you already use:

```ts
// Sentry — automatic OTel setup with tracesSampleRate
import * as Sentry from '@sentry/node';
Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 });
```

```ts
// Datadog
import tracer from 'dd-trace';
tracer.init({ service: 'orders-service' });
```

```ts
// Jaeger / Tempo / OTel Collector — NodeSDK + OTLP
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
new NodeSDK({
  serviceName: 'orders-service',
  traceExporter: new OTLPTraceExporter({ url: 'http://jaeger:4318/v1/traces' }),
}).start();
```

### Disabled by default — zero overhead

When no OpenTelemetry SDK is registered in the host application, every internal `trace.getTracer()` call resolves to a no-op tracer. The transport still walks through the span helpers, but each call exits on the first guard. There is no measurable overhead on the hot path, and `@opentelemetry/api` is declared as an optional peer dependency — applications that do not want tracing do not pay for it in their bundle either.

## What gets traced

The default trace set covers the message-flow operations that map onto a distributed trace waterfall:

- **`publish`** &mdash; `PRODUCER` span. Fires for every `client.emit()` and for the publish portion of an RPC `client.send()`.
- **`consume`** &mdash; `CONSUMER` span. Fires for every handler invocation. Retries produce additional spans with `messaging.nats.message.delivery_count > 1`.
- **`rpc.client.send`** &mdash; `CLIENT` span. Covers the full RPC round-trip on the caller side, from publish through reply or timeout.
- **`dead_letter`** &mdash; `INTERNAL` span. Fires when a message exhausts `maxDeliver` and the DLQ flow runs.

Infrastructure trace kinds (connection lifecycle, self-healing, provisioning, migration, shutdown) exist in the `JetstreamTrace` enum but are off by default. Enable them explicitly when you need that level of detail.

```ts
import { JetstreamTrace } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  servers: ['nats://localhost:4222'],
  otel: {
    traces: [
      JetstreamTrace.Publish,
      JetstreamTrace.Consume,
      JetstreamTrace.RpcClientSend,
      JetstreamTrace.DeadLetter,
      JetstreamTrace.ConnectionLifecycle, // opt-in
    ],
  },
});
```

Use `traces: 'all'` to enable every kind, `traces: 'none'` to suppress span emission entirely while keeping context propagation alive.

## Configuration reference

```ts
otel?: {
  /** Master kill switch. @default true */
  enabled?: boolean;

  /** Which trace kinds to emit. @default 'default' */
  traces?: JetstreamTrace[] | 'default' | 'all' | 'none';

  /**
   * Header allowlist. Glob-supported (e.g. `['x-*', '!x-internal-*']`).
   * @default ['x-request-id']
   *
   * Transport-internal headers (`x-correlation-id`, `x-reply-to`, `x-error`,
   * `x-subject`, `x-caller-name`) and propagator-owned headers
   * (`traceparent`, `tracestate`, `baggage`, `sentry-trace`, `b3`, …)
   * are suppressed regardless of the allowlist. The RPC correlation id
   * surfaces on spans as `messaging.message.conversation_id` instead.
   */
  captureHeaders?: string[] | boolean;

  /** Capture message payloads. @default false */
  captureBody?: boolean | { maxBytes?: number; subjectAllowlist?: string[] };

  /** Synchronous hooks for custom span enrichment. */
  publishHook?: (span, ctx) => void;
  consumeHook?: (span, ctx) => void;
  responseHook?: (span, ctx) => void;

  /** Skip span creation per-publish/per-consume while still propagating trace context. */
  shouldTracePublish?: (subject, record) => boolean;
  shouldTraceConsume?: (subject, msg) => boolean;

  /** Classify thrown errors as expected (OK span) or unexpected (ERROR span). */
  errorClassifier?: (err) => 'expected' | 'unexpected';
}
```

## Error classification

Handler errors are classified by exception type. The classifier drives **only** OpenTelemetry span status — it does not affect logs, hooks, or the reply envelope returned to the caller.

- **`RpcException` / `HttpException`** &mdash; span status `OK`, with `jetstream.rpc.reply.has_error` and `jetstream.rpc.reply.error.code` attributes attached.
- **Bare `Error` / unknown thrown value** &mdash; span status `ERROR`, with `span.recordException(err)` attached.

This keeps APM error rates clean for business outcomes that are part of the contract (auth denials, validation failures) while loud-failing on real bugs and infrastructure problems. Override the default with a custom classifier when your team uses other primitives:

```ts
otel: {
  errorClassifier: (err) => {
    if (err instanceof MyDomainError) return 'expected';
    if (typeof err === 'object' && err !== null && 'code' in err && /^BIZ_/.test((err as { code: string }).code)) {
      return 'expected';
    }
    return 'unexpected';
  },
}
```

## Security and privacy

Two configuration knobs deal with potentially sensitive data. Both default to safe values; opting in is a deliberate choice.

### `captureHeaders`

Captures matching message headers as `messaging.header.<name>` span attributes. Default allowlist is `['x-request-id']`. Glob wildcards (`x-*`, `*-id`) and exclusions (`!x-internal-*`) are supported.

The library-internal `x-correlation-id` is never emitted as a `messaging.header.*` attribute even if added to the allowlist — it surfaces on RPC spans as the standard `messaging.message.conversation_id` attribute instead, which keeps the OpenTelemetry semantic-conventions contract intact and avoids duplicating the same value under two keys.

:::warning
Headers frequently carry authentication tokens, session identifiers, and other sensitive data. Captured values are exported to your OTel backend (Sentry, Datadog, etc.). **Never set `captureHeaders: true` in production** — that captures every header. Use an explicit allowlist.
:::

The library always excludes propagator-owned headers (`traceparent`, `tracestate`, `baggage`, `sentry-trace`, `b3`, `x-b3-*`, Jaeger format) from capture even when the matcher would pass them — they are noise and already represented by the span's own context.

### `captureBody`

Captures the message payload as a `messaging.nats.message.body` span attribute. Default is `false`.

:::danger
Message payloads commonly contain PII, credentials, financial data, or content regulated by GDPR, HIPAA, or PCI-DSS. Enabling body capture in production is almost always a policy violation. Keep the default unless you are in a controlled environment, or pair the capture with a custom `SpanProcessor` that scrubs or drops the attribute before export.
:::

When enabled, payloads are UTF-8 decoded if possible (base64 otherwise), truncated at the configured `maxBytes` (default 4096), and flagged with a `messaging.nats.message.body.truncated` attribute when truncation occurs.

```ts
otel: {
  captureBody: { maxBytes: 8192, subjectAllowlist: ['orders.*'] },
}
```

## Custom enrichment hooks

Three hooks let you attach business-specific attributes to library-emitted spans without subclassing or wrapping:

```ts
otel: {
  publishHook: (span, ctx) => {
    span.setAttribute('app.tenant_id', extractTenant(ctx.record));
  },
  consumeHook: (span, ctx) => {
    span.setAttribute('app.handler', `${ctx.handlerMetadata.pattern}`);
  },
  responseHook: (span, ctx) => {
    if (ctx.error) span.setAttribute('app.error_class', ctx.error.constructor.name);
  },
}
```

Hooks are synchronous — they run inline with span creation and termination. Errors thrown from a hook are caught and logged at `debug` level; they cannot disrupt the message flow.

## Skipping spans for noisy subjects

Health-check pings and other internal traffic often do not deserve span output. Use the `shouldTrace*` predicates to skip span creation while still letting trace context flow through:

```ts
otel: {
  shouldTracePublish: (subject) => !subject.startsWith('health.'),
  shouldTraceConsume: (subject) => !subject.startsWith('health.'),
}
```

## Cross-language interoperability

The transport reads and writes the W3C Trace Context standard (`traceparent`, `tracestate`, `baggage`). Any publisher that injects a `traceparent` header is automatically linked into the trace, regardless of language or runtime — Go, Python, Java, Rust, or a bare `curl` invocation.

For the precise header contract used at the wire level, see the [Header Contract reference](../reference/header-contract).

## Troubleshooting

**No spans appear in my APM.**
Confirm that an OpenTelemetry SDK has been registered _before_ the application bootstraps. The library's tracer calls are no-ops until `trace.setGlobalTracerProvider()` runs. With `@opentelemetry/sdk-node`, calling `sdk.start()` handles this. With Sentry / Datadog / New Relic SDKs, calling `Sentry.init()` / `tracer.init()` does it for you.

**Trace breaks at my service boundary on internal `client.emit()` calls.**
This requires an OpenTelemetry `ContextManager` (typically `AsyncLocalStorageContextManager`) so the active trace context survives across `await` points inside your handler. Every modern OTel-aware SDK (Sentry, Datadog, NodeSDK) registers one automatically. If you only installed `@opentelemetry/api` without an SDK, register the context manager explicitly.

**Span attributes contain sensitive data.**
Review your `captureHeaders` allowlist — set explicit headers, never `true`. Confirm `captureBody` is `false`. If you need backend-side scrubbing, register a custom `SpanProcessor` that drops or rewrites attributes in `onEnd`.

**Span name format looks "reversed" in my APM.**
The library uses the OpenTelemetry messaging convention: `{operation} {destination}` (`publish orders.created`, `process orders.created`). Some older APMs render it differently — rendering is a UI concern, not a span data issue.
