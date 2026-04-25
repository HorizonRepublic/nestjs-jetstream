# Example 10 — Distributed Tracing

End-to-end demonstration of the library's built-in OpenTelemetry instrumentation.

## What it shows

- **CLIENT span** for every `client.send()` RPC round-trip.
- **PRODUCER span** for every `client.emit()` publish.
- **CONSUMER span** for every handler invocation, parented to the upstream span via the W3C `traceparent` header.
- **Connection lifecycle INTERNAL span** because this example opts into `JetstreamTrace.ConnectionLifecycle`.

Spans are exported to the console with full attributes — start the example, hit the HTTP endpoint, watch one trace flow across all participants in your terminal.

## Prerequisites

- A running NATS server at `localhost:4222`. The repo's root `docker compose up -d` brings one up.
- Node.js >= 20.

## Run

```bash
npx tsx --tsconfig examples/tsconfig.json examples/10-distributed-tracing/main.ts
```

Then in another terminal:

```bash
curl http://localhost:3009
```

You'll see a sequence of console-printed spans for one trace:

1. `send orders.place` (CLIENT, kind=2) — the round-trip on the caller side
2. `publish orders.place` (PRODUCER, kind=3) — the actual NATS publish
3. `process orders.place` (CONSUMER, kind=4) — the handler on the server
4. `publish orders.placed` (PRODUCER, kind=3) — the follow-up event
5. `process orders.placed` (CONSUMER, kind=4) — the audit handler

Same `traceId` on all five. `parentSpanId` chains them together.

## Switching to a real backend

This example uses `ConsoleSpanExporter` for visibility. Swap in any OTLP-compatible exporter to send spans to Jaeger, Tempo, Honeycomb, Datadog, Sentry, or anything else:

```ts
// tracing.ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const exporter = new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' });
```

### Sentry

Sentry v8+ exposes its tracing stack through `@sentry/opentelemetry`. Either let
Sentry auto-wire OTel with `Sentry.init({ tracesSampleRate: 1.0 })` and skip
your own `NodeSDK` setup, or opt out of Sentry's wiring (`skipOpenTelemetrySetup: true`)
and register Sentry's span processor, context manager, and propagator manually.
Follow the [Sentry OpenTelemetry guide](https://docs.sentry.io/platforms/javascript/guides/node/opentelemetry/)
for the exact wiring — the library's spans flow through once the OTel
TracerProvider Sentry registers becomes the global one.

### Datadog

`dd-trace` does not bridge external OTel spans by default. Initialise it with
`require('dd-trace').init()` **and** set `DD_TRACE_OTEL_ENABLED=true`, or register
`dd-trace`'s TracerProvider via `@opentelemetry/api`'s
`trace.setGlobalTracerProvider(...)`. See the
[Datadog OpenTelemetry interop docs](https://docs.datadoghq.com/tracing/trace_collection/custom_instrumentation/otel_instrumentation/nodejs/)
for the current procedure.
