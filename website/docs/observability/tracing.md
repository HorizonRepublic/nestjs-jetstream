---
sidebar_position: 1
sidebar_label: "Distributed Tracing"
title: "Distributed Tracing: NestJS JetStream Transport"
description: "Built-in W3C Trace Context propagation and OpenTelemetry spans for every publish, consume, and RPC round-trip. Works zero-config with Sentry, Datadog, Jaeger, Tempo, Honeycomb, and any OTel-compatible APM."
schema:
  type: Article
  headline: "Distributed Tracing: NestJS JetStream Transport"
  description: "Built-in W3C Trace Context propagation and OpenTelemetry spans for every publish, consume, and RPC round-trip."
  datePublished: "2026-04-24"
  dateModified: "2026-10-30"
---

# Distributed Tracing

> **Use when:** a request crosses services and you need one trace across the hops.
> **You get:** OpenTelemetry spans for publish, consume and RPC, and the attributes each one carries.

Trace context travels in NATS message headers as W3C Trace Context, so one trace follows a message from `client.emit('orders.created')` through every consumer, RPC hop and dead-letter branch, across services and languages.

## Setup

Tracing is on by default and activates when your application registers an OpenTelemetry SDK. **No transport-side configuration is required.**

```ts
// tracing.ts, load this BEFORE your AppModule
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

new NodeSDK({
  serviceName: 'orders-service',
  traceExporter: new OTLPTraceExporter({ url: 'http://collector:4318/v1/traces' }),
}).start();
```

### Vendor SDKs

Most Node.js APM SDKs register OpenTelemetry themselves, so their usual init is enough:

```ts
// Sentry, automatic OTel setup with tracesSampleRate
import * as Sentry from '@sentry/node';
Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 });
```

```ts
// Datadog
import tracer from 'dd-trace';
tracer.init({ service: 'orders-service' });
```

Jaeger, Tempo and an OTel Collector take the `NodeSDK` setup above with their OTLP endpoint.

### No SDK, no overhead

Without a registered SDK, every `trace.getTracer()` call resolves to a no-op tracer and each span helper exits on its first guard. `@opentelemetry/api` is a required peer dependency, and installing it alone turns nothing on.

## What gets traced

| `JetstreamTrace`      | Span kind  | Default | Fires                                                                                                 |
| --------------------- | ---------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `Publish`             | `PRODUCER` | on      | Every `client.emit()`, and the publish leg of `client.send()`                                         |
| `Consume`             | `CONSUMER` | on      | Every handler invocation. Retries get their own span with `messaging.nats.message.delivery_count > 1` |
| `RpcClientSend`       | `CLIENT`   | on      | The full RPC round-trip on the caller, from publish to reply, timeout or cancellation                 |
| `DeadLetter`          | `INTERNAL` | on      | A message exhausts `max_deliver`; covers the `onDeadLetter` callback                                  |
| `ConnectionLifecycle` | `INTERNAL` | off     | One span per NATS connection session, with connect, reconnect and disconnect events                   |
| `SelfHealing`         | `INTERNAL` | off     | Each consumer recovery attempt                                                                        |
| `Provisioning`        | `INTERNAL` | off     | Each stream or consumer created or updated at startup                                                 |
| `Migration`           | `INTERNAL` | off     | A destructive stream migration                                                                        |
| `Shutdown`            | `INTERNAL` | off     | The graceful shutdown sequence                                                                        |

`DEFAULT_TRACES` holds the four default kinds. Pass your own list to change it:

```ts
import { JetstreamTrace } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
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

`traces: 'all'` enables every kind; `traces: 'none'` emits no spans but keeps propagating context. `otel: true` means the defaults and `otel: false` means `{ enabled: false }`, which also stops propagation and hook calls.

## Configuration reference

```ts
otel?: boolean | {
  /** Master kill switch. @default true */
  enabled?: boolean;

  /** Which trace kinds to emit. @default 'default' */
  traces?: JetstreamTrace[] | 'default' | 'all' | 'none';

  /**
   * Header allowlist. Glob-supported (e.g. `['x-*', '!x-internal-*']`).
   * @default ['x-request-id']
   *
   * Some headers are never captured, see Security and privacy below.
   */
  captureHeaders?: string[] | boolean;

  /** Capture message payloads. `true` means maxBytes 4096. @default false */
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

The classifier drives **only** the span status: logs, hooks and the reply envelope stay the same either way. By default:

- **`RpcException` / `HttpException`**, span status `OK`, with `jetstream.rpc.reply.has_error` and `jetstream.rpc.reply.error.code` attributes attached.
- **Bare `Error` / unknown thrown value**, span status `ERROR`, with `span.recordException(err)` attached.

Business outcomes that belong to the contract (auth denials, validation failures) stay out of APM error rates, and real bugs still show. Override it for your own error types:

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

### `captureHeaders`

Captures matching headers as `messaging.header.<name>` span attributes, matched case-insensitively. Default allowlist is `['x-request-id']`. Glob wildcards (`x-*`, `*-id`) and exclusions (`!x-internal-*`) are supported.

These are never captured, whatever the allowlist says:

- propagator-owned headers: `traceparent`, `tracestate`, `baggage`, `sentry-trace`, `b3`, `x-b3-*`, `uber-trace-id`, already represented by the span's own context;
- transport headers: `x-correlation-id`, `x-reply-to`, `x-error`, `x-subject`, `x-caller-name`. The correlation id appears on RPC spans as `messaging.message.conversation_id` instead;
- every server-managed `Nats-*` header.

:::warning
Headers frequently hold authentication tokens, session identifiers, and other sensitive data. Captured values are exported to your OTel backend (Sentry, Datadog, etc.). **Never set `captureHeaders: true` in production**: that captures every header. Use an explicit allowlist.
:::

### `captureBody`

Captures the message payload as a `messaging.nats.message.body` span attribute. Default is `false`.

:::danger
Message payloads commonly contain PII, credentials, financial data, or content regulated by GDPR, HIPAA, or PCI-DSS. Enabling body capture in production is almost always a policy violation. Keep the default unless you are in a controlled environment, or pair the capture with a custom `SpanProcessor` that scrubs or drops the attribute before export.
:::

Payloads are UTF-8 decoded where possible and base64 otherwise, then truncated at `maxBytes` (default 4096). A truncated payload carries a `messaging.nats.message.body.truncated` attribute. `subjectAllowlist` takes `*` globs and limits capture to matching subjects.

```ts
otel: {
  captureBody: { maxBytes: 8192, subjectAllowlist: ['orders.*'] },
}
```

## Custom enrichment hooks

Attach your own attributes to the library's spans:

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

`publishHook` runs before the publish, `consumeHook` before the handler, and `responseHook` once the outcome is known, just before the span ends (publish, consume and RPC client spans). Hooks are synchronous; an error thrown in one is caught and logged at `debug` level.

## Skipping spans for noisy subjects

The `shouldTrace*` predicates skip span creation for traffic such as health checks, while trace context still flows and the handler still runs:

```ts
otel: {
  shouldTracePublish: (subject) => !subject.startsWith('health.'),
  shouldTraceConsume: (subject) => !subject.startsWith('health.'),
}
```

## Cross-language interoperability

Any publisher that injects a `traceparent` header joins the trace, whatever its language. The [Header Contract](/docs/reference/header-contract) has the wire-level details and Go and Python examples.

## Troubleshooting

**No spans appear in my APM.**
Register the OpenTelemetry SDK _before_ the application bootstraps: tracer calls are no-ops until `trace.setGlobalTracerProvider()` runs. `sdk.start()`, `Sentry.init()` and `tracer.init()` all do that. Also check that `otel` is not `false` and `traces` is not `'none'`.

**Trace breaks at my service boundary on internal `client.emit()` calls.**
The active context has to survive `await` points inside your handler, which needs an OpenTelemetry `ContextManager` (typically `AsyncLocalStorageContextManager`). Sentry, Datadog and `NodeSDK` register one; with a bare `@opentelemetry/api` setup, register it yourself.

**Span attributes contain sensitive data.**
Use an explicit `captureHeaders` allowlist, never `true`, and keep `captureBody` at `false`. For scrubbing, register a `SpanProcessor` that drops or rewrites attributes in `onEnd`.

**Span name format looks "reversed" in my APM.**
Span names follow the OpenTelemetry messaging convention, `{operation} {destination}` (`publish orders.created`, `process orders.created`). Some older APMs render it differently; the span data is the same.
