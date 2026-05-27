---
sidebar_position: 2
sidebar_label: "Prometheus Metrics"
title: "Prometheus Metrics — NestJS JetStream Transport"
description: "Production-ready Prometheus metrics for NATS JetStream transport: throughput, handler latency, consumer lag, dead letters, and publish errors. Zero-config integration with @willsoto/nestjs-prometheus."
schema:
  type: Article
  headline: "Prometheus Metrics — NestJS JetStream Transport"
  description: "Production-ready Prometheus metrics for NATS JetStream transport: throughput, handler latency, consumer lag, dead letters, and publish errors."
  datePublished: "2026-05-27"
  dateModified: "2026-05-27"
---

# Prometheus Metrics

The transport ships built-in Prometheus metrics covering throughput, handler latency, consumer lag, publish errors, dead letters, and connection health. Metrics are written to a `prom-client` registry — the de-facto standard in the NestJS ecosystem — so any `/metrics` endpoint exporter picks them up without additional wiring.

## Why this exists

Traces tell you what happened to one message; metrics tell you what's happening to the system as a whole. NATS JetStream is a queue, a stream store, and an RPC bus rolled into one, and operators need to know things like "is my consumer falling behind?" or "what's the p99 handler latency for `orders.created` over the last hour?" Those are aggregate questions — Prometheus territory, not APM territory.

The library exposes everything an operator typically alerts on:

- **Throughput**: messages received, processed, published, and dead-lettered per second.
- **Latency**: handler duration, publish duration, and RPC round-trip duration as histograms.
- **Lag**: consumer `num_pending`, `num_ack_pending`, and stream size as gauges.
- **Health**: connection state, RPC timeouts, transport errors classified by context.

Default labels stay bounded (declared patterns, enum-typed statuses, named kinds), so dashboards stay performant as your handler count grows.

## Setup

Install the optional peer dependency once:

```bash
pnpm add prom-client
```

The transport declares `prom-client` as an **optional peer**. If you do not enable metrics, the package is never imported. Tested against `prom-client@^15`.

Enable metrics in `forRoot`:

```ts
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['nats://localhost:4222'],
      metrics: true,
    }),
  ],
})
export class AppModule {}
```

…or with `forRootAsync`:

```ts
JetstreamModule.forRootAsync({
  name: 'orders',
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    servers: config.get<string[]>('NATS_SERVERS')!,
    metrics: true,
  }),
})
```

That's the whole integration. Metrics write to `prom-client`'s global `register`. To expose them at `/metrics`, pair the transport with `@willsoto/nestjs-prometheus`:

```ts
import { PrometheusModule } from '@willsoto/nestjs-prometheus';

@Module({
  imports: [
    PrometheusModule.register(),               // exposes /metrics
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['nats://localhost:4222'],
      metrics: true,                            // writes to the same global register
    }),
  ],
})
export class AppModule {}
```

`curl localhost:3000/metrics` returns your application's metrics and the transport's metrics in a single Prometheus exposition.

### Full configuration

```ts
import { Registry } from 'prom-client';

JetstreamModule.forRoot({
  // ...
  metrics: {
    register: customRegister,            // default: prom-client's global register
    prefix: 'jetstream_',                // default: 'jetstream_'
    defaultLabels: { service: 'orders', env: 'prod' },
    pollInterval: 15_000,                // default: 15s; set 0 to disable gauge polling
    buckets: {
      handlerDuration: [0.001, 0.01, 0.1, 1, 10],
      publishDuration: [0.001, 0.01, 0.1, 1, 10],
      rpcDuration:     [0.001, 0.01, 0.1, 1, 10],
    },
  },
})
```

### Disabled by default — zero overhead

When the `metrics` option is omitted or set to `false`:

- `prom-client` is never imported (the dynamic `import()` only runs when `metrics` is truthy).
- The transport's hot paths add ~30 nanoseconds per message (a single `Map.get` to check if a listener exists) — effectively free.

Production deployments that don't need metrics pay nothing for the feature.

## Metric catalog

All metric names are prefixed with `jetstream_` (configurable). `defaultLabels` from the config are merged into every metric.

### Counters

| Name                                | Labels                              | Description |
| ----------------------------------- | ----------------------------------- | ----------- |
| `jetstream_messages_received_total` | `stream`, `subject`, `kind`         | Messages routed to a handler. |
| `jetstream_messages_processed_total`| `stream`, `subject`, `kind`, `status` | Handler invocations that completed. `status` ∈ `success`, `error`, `retried`, `terminated`. |
| `jetstream_messages_unhandled_total`| `subject` (literal `<unmatched>`)   | Messages with no matching handler. |
| `jetstream_messages_dead_letter_total` | `stream`, `subject`              | Messages that exhausted all delivery attempts. |
| `jetstream_publish_total`           | `subject`, `kind`, `status`         | Client-side publish operations. `status` ∈ `success`, `error`. |
| `jetstream_rpc_timeout_total`       | `subject`                           | RPC calls that exceeded the timeout deadline. |
| `jetstream_consumer_recovered_total`| `kind`                              | Self-healing recoveries after consume-loop failures. |
| `jetstream_errors_total`            | `context`                           | Transport-level errors. `context` ∈ `connection`, `codec`, `publish`, `consume`, `handler`, `shutdown`, `other`. |
| `jetstream_metrics_poll_errors_total` | `target`                          | Errors hit while polling for gauge data. `target` ∈ `consumer.info`, `stream.info`, `jsm.connect`. |

### Histograms

| Name                                  | Labels                              | Source |
| ------------------------------------- | ----------------------------------- | ------ |
| `jetstream_handler_duration_seconds`  | `stream`, `subject`, `kind`, `status` | Wall-clock duration from handler entry to settlement. |
| `jetstream_publish_duration_seconds`  | `subject`, `kind`, `status`         | Wall-clock duration of client publish operations. |
| `jetstream_rpc_duration_seconds`      | `subject`, `status`                 | Full RPC round-trip from caller's perspective. `status` includes `timeout`. |

Default buckets (in seconds): `[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`. Cover sub-millisecond RPC up to ten-second batch handlers. Override via `metrics.buckets`.

### Gauges (polled)

Refreshed every `pollInterval` ms by querying `JetStreamManager.consumers.info()` and `JetStreamManager.streams.info()` for every consumer this service owns.

| Name                              | Labels                              | Source field |
| --------------------------------- | ----------------------------------- | ------------ |
| `jetstream_consumer_num_pending`  | `stream`, `consumer`, `kind`        | `ConsumerInfo.num_pending` |
| `jetstream_consumer_num_ack_pending` | `stream`, `consumer`, `kind`     | `ConsumerInfo.num_ack_pending` |
| `jetstream_consumer_num_redelivered` | `stream`, `consumer`, `kind`     | `ConsumerInfo.num_redelivered` |
| `jetstream_consumer_num_waiting`  | `stream`, `consumer`, `kind`        | `ConsumerInfo.num_waiting` |
| `jetstream_stream_messages`       | `stream`                            | `StreamInfo.state.messages` |
| `jetstream_stream_bytes`          | `stream`                            | `StreamInfo.state.bytes` |
| `jetstream_connection_up`         | `server`                            | `1` while connected, `0` after disconnect. |

Setting `pollInterval: 0` (or `false`) disables the polling loop entirely. Counter and histogram metrics continue to update from event hooks.

### Label values

Every label value is bounded — no free-form data ever reaches a label. The `subject` label is sourced from the **declared pattern** in `@EventPattern` / `@MessagePattern`, not from the wire NATS subject, so cardinality is bounded by your handler count.

- **`kind`** &mdash; `event`, `command`, `broadcast`, `ordered`.
- **`status`** on handler metrics &mdash; `success`, `error`, `retried`, `terminated`.
- **`status`** on publish metrics &mdash; `success`, `error`.
- **`status`** on RPC round-trip metrics &mdash; `success`, `error`, `timeout`.
- **`context`** on `jetstream_errors_total` &mdash; `connection`, `codec`, `publish`, `consume`, `handler`, `shutdown`, `other`.

## PromQL examples

Throughput — messages received per second by stream kind:

```promql
sum by (kind) (rate(jetstream_messages_received_total[1m]))
```

p99 handler latency for a specific event:

```promql
histogram_quantile(
  0.99,
  sum by (le) (
    rate(jetstream_handler_duration_seconds_bucket{subject="orders.created"}[5m])
  )
)
```

Error rate per handler:

```promql
sum by (subject) (rate(jetstream_messages_processed_total{status="error"}[5m]))
  / sum by (subject) (rate(jetstream_messages_processed_total[5m]))
```

Alert if consumer lag exceeds 10k pending messages:

```promql
jetstream_consumer_num_pending > 10000
```

Alert if NATS connection has been down for 5 minutes:

```promql
jetstream_connection_up == 0
```

p95 RPC round-trip latency excluding timeouts:

```promql
histogram_quantile(
  0.95,
  sum by (subject, le) (
    rate(jetstream_rpc_duration_seconds_bucket{status!="timeout"}[5m])
  )
)
```

## Polling behavior

The polling loop pulls `consumer.info()` and `streams.info()` from the NATS server at the configured `pollInterval`. The loop is deliberately conservative:

- **Backpressure**: if a previous tick has not completed by the time the next interval fires, the new tick is skipped (no queueing). A warn log is emitted so operators can tell when the configured interval is too aggressive for the load.
- **Per-target error isolation**: a failing `consumer.info()` call increments `jetstream_metrics_poll_errors_total{target="consumer.info"}` but does not abort the remainder of the cycle. Streams and other consumers in the same tick still update.
- **Graceful shutdown**: `OnModuleDestroy` cancels the timer and awaits the in-flight tick before resolving, so the process exits cleanly.
- **Connection-loss tolerance**: while NATS is disconnected, polling fails fast and increments the poll-error counter. Gauges become stale (not zero) — which is the correct semantic: we do not know the values, so we do not lie about them.

The Command (RPC) consumer is only polled in JetStream RPC mode. Core RPC mode does not create a JetStream stream for commands, so there is nothing to poll. Ordered consumers are ephemeral and do not have a stable durable name, so they are excluded from polling — use `jetstream_messages_processed_total{kind="ordered"}` to monitor ordered throughput instead.

## Cardinality safety

Prometheus performance degrades sharply with high cardinality, so the design avoids unbounded labels:

- `subject` uses the **declared** pattern (e.g. `orders.created`) from `@EventPattern`, never the wire NATS subject. Subject wildcards are not supported in handler patterns — the router uses exact-match lookup — so declared and wire subjects coincide today. Pinning to the declared form future-proofs the metric.
- `kind`, `status`, and `context` are all enum-typed with a small bounded set of values.
- `stream` and `consumer` are deterministic functions of `serviceName` and `StreamKind`.
- `server` is bounded by the NATS cluster size.
- For unmatched messages, `subject="<unmatched>"` is used as a single sentinel rather than the actual subject — preventing an attacker from blowing up cardinality by publishing to random subjects.

If you set `defaultLabels` with high-cardinality values (e.g. per-request IDs), Prometheus performance is on you — the transport never injects unbounded labels itself.

## Performance characteristics

Per-message overhead with metrics enabled:

- 1× `performance.now()` at handler entry.
- 1× `EventBus.emit(HandlerCompleted, ...)` after settlement — `Map.get` + callback invocation.
- 1× `PatternRegistry.resolveDeclared()` (a `Map.get`) inside the metrics service.
- 1× `Counter.inc()` + 1× `Histogram.observe()` in `prom-client`.

Aggregate cost: **~5–10 microseconds per message** on modern hardware. For a service handling 10,000 messages per second, that is ~50ms of CPU time per second of wall clock — well under 5% overhead and dominated by the NATS round-trip itself.

Polling cost: 1 `consumer.info` + 1 `streams.info` per consumer kind every `pollInterval` ms. For a service with both event and RPC handlers in JetStream mode, that's roughly 0.27 NATS requests per second at the default 15s interval — negligible.

Memory: each metric family allocates roughly 200 bytes per label combination. With ~100 declared subjects × 4 statuses × 4 kinds, all 19 metric families together stay under ~10 MB of heap.

## Custom hooks alongside metrics

Adding `metrics: true` does not interfere with user-provided `hooks`. The transport delivers events to both your hooks and the metrics service:

```ts
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  metrics: true,
  hooks: {
    [TransportEvent.DeadLetter]: async (info) => {
      await sentry.captureMessage(`Dead letter: ${info.subject}`, { extra: info });
    },
  },
});
```

The `HandlerCompleted`, `Published`, and `RpcCompleted` events used internally by the metrics service are also part of the public `TransportHooks` surface — register your own listeners if you want to add custom alerting on top of the built-in counters.

## Multi-registry deployments

If your application exposes multiple `/metrics` endpoints (e.g. one per tenant), pass a dedicated `Registry` instance per metrics endpoint. The transport writes to whatever registry you supply:

```ts
import { Registry } from 'prom-client';

const tenantRegister = new Registry();

JetstreamModule.forRoot({
  // ...
  metrics: { register: tenantRegister },
});
```

Multiple `JetstreamModule` instances are not currently supported (the library expects a single connection per service), so multi-registry use cases are limited to running the transport once with metrics scoped to a non-default registry.
