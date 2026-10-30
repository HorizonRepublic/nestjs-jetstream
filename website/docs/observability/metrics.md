---
sidebar_position: 2
sidebar_label: "Prometheus Metrics"
title: "Prometheus Metrics: NestJS JetStream Transport"
description: "Built-in Prometheus metrics for NATS JetStream transport: throughput, handler latency, consumer lag, dead letters, and publish errors. Zero-config integration with @willsoto/nestjs-prometheus."
schema:
  type: Article
  headline: "Prometheus Metrics: NestJS JetStream Transport"
  description: "Built-in Prometheus metrics for NATS JetStream transport: throughput, handler latency, consumer lag, dead letters, and publish errors."
  datePublished: "2026-05-27"
  dateModified: "2026-10-30"
---

# Prometheus Metrics

> **Use when:** you are putting this service on a Prometheus dashboard.
> **You get:** the metric catalog, PromQL to start from, and what collection costs at runtime.

Metrics are written to a Prometheus registry from `@prometheus-io/client` or `prom-client`, its previous name, so any `/metrics` exporter picks them up without extra wiring.

## What it covers

Traces tell you what happened to one message; metrics answer aggregate questions such as whether a consumer keeps up, or the p99 handler latency for `orders.created` over the last hour:

- **Throughput**: messages received, processed, published, and dead-lettered per second.
- **Latency**: histograms for handler duration, publish duration and the RPC round trip.
- **Lag**: consumer `num_pending`, `num_ack_pending`, and stream size as gauges.
- **Health**: connection state and RPC timeouts, plus transport errors classified by context.

## Setup

Install one Prometheus client:

```bash npm2yarn
npm install @prometheus-io/client
```

The transport accepts either package. Both are **optional peers**: without `metrics` enabled, neither is imported. Tested against `@prometheus-io/client@^0.16` and `prom-client@^15`.

If your `/metrics` exporter still runs on `prom-client`, as `@willsoto/nestjs-prometheus` does, keep `prom-client` so both write to the same global registry.

:::warning Both packages installed
With `@prometheus-io/client` and `prom-client` both installed, their global registries are two different objects and only one of them is scraped. The transport will not guess: startup fails until you pass `metrics.register` with the registry your exporter serves. Metrics are then built with classes from that registry's package.
:::

Set `metrics: true` in `forRoot()` or in the `forRootAsync()` factory. Metrics then write to the installed package's global `register`. To expose them at `/metrics`, pair the transport with `@willsoto/nestjs-prometheus`:

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
JetstreamModule.forRoot({
  // ...
  metrics: {
    register: customRegister,            // default: the installed package's global register
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

### Disabled by default: zero overhead

With `metrics` omitted or `false`, no Prometheus client is imported (the lazy `import()` runs only when `metrics` is truthy), and the hot path costs one `Map.get` per event to find no listener.

## Metric catalog

All metric names are prefixed with `jetstream_` (configurable). `defaultLabels` from the config are merged into every metric.

### Counters

| Name                                   | Labels                                | Description                                                                                                                          |
| -------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `jetstream_messages_received_total`    | `stream`, `subject`, `kind`           | Messages routed to a handler.                                                                                                        |
| `jetstream_messages_processed_total`   | `stream`, `subject`, `kind`, `status` | Handler invocations that completed. `status` ∈ `success`, `error`, `retried`, `terminated`.                                          |
| `jetstream_messages_unhandled_total`   | `subject` (literal `<unmatched>`)     | Messages with no matching handler.                                                                                                   |
| `jetstream_messages_dead_letter_total` | `stream`, `subject`                   | Messages that exhausted all delivery attempts.                                                                                       |
| `jetstream_publish_total`              | `subject`, `kind`, `status`           | Client-side publish operations. `status` ∈ `success`, `error`.                                                                       |
| `jetstream_rpc_timeout_total`          | `subject`, `side`                     | RPC calls that exceeded the timeout deadline. `side` ∈ `client` (caller gave up waiting), `server` (handler ran past `rpc.timeout`). |
| `jetstream_consumer_recovered_total`   | `kind`                                | Self-healing recoveries after consume-loop failures.                                                                                 |
| `jetstream_errors_total`               | `context`                             | Transport-level errors. `context` ∈ `connection`, `codec`, `publish`, `consume`, `handler`, `shutdown`, `other`.                     |
| `jetstream_metrics_poll_errors_total`  | `target`                              | Errors hit while polling for gauge data. `target` ∈ `consumer.info`, `stream.info`, `jsm.connect`.                                   |

### Histograms

| Name                                 | Labels                                | Source                                                                                      |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `jetstream_handler_duration_seconds` | `stream`, `subject`, `kind`, `status` | Wall-clock duration from handler entry to settlement.                                       |
| `jetstream_publish_duration_seconds` | `subject`, `kind`, `status`           | Wall-clock duration of client publish operations.                                           |
| `jetstream_rpc_duration_seconds`     | `subject`, `status`                   | Full RPC round-trip from caller's perspective. `status` includes `timeout` and `cancelled`. |

Handler and RPC buckets run `[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` seconds, covering sub-millisecond calls up to ten-second batch handlers. Publish stops at `5`, since a publish still running after five seconds is a connection problem to investigate elsewhere. Override any of the three via `metrics.buckets`.

### Gauges

All but `jetstream_connection_up` are refreshed every `pollInterval` ms from `consumers.info()` and `streams.info()` for every durable consumer this service owns. `jetstream_connection_up` follows connection events.

| Name                                 | Labels                       | Source field                                                                                   |
| ------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `jetstream_consumer_num_pending`     | `stream`, `consumer`, `kind` | `ConsumerInfo.num_pending`                                                                     |
| `jetstream_consumer_num_ack_pending` | `stream`, `consumer`, `kind` | `ConsumerInfo.num_ack_pending`                                                                 |
| `jetstream_consumer_num_redelivered` | `stream`, `consumer`, `kind` | `ConsumerInfo.num_redelivered`                                                                 |
| `jetstream_consumer_num_waiting`     | `stream`, `consumer`, `kind` | `ConsumerInfo.num_waiting`                                                                     |
| `jetstream_stream_messages`          | `stream`                     | `StreamInfo.state.messages`                                                                    |
| `jetstream_stream_bytes`             | `stream`                     | `StreamInfo.state.bytes`                                                                       |
| `jetstream_connection_up`            | `server`                     | `1` while a connection on that server is up, `0` once every connection on it has disconnected. |

`pollInterval: 0` turns polling off. Counters and histograms keep updating from transport events.

### Label values

Every label value is bounded, so cardinality grows with your handler count and nothing else:

- **`subject`** is the **declared** pattern from `@EventPattern` / `@MessagePattern`, never the wire subject. A message with no handler counts under the single sentinel `<unmatched>`, so publishing to random subjects cannot inflate cardinality.
- **`kind`**: `event`, `command`, `broadcast`, `ordered`, `schedule`.
- **`status`** on handler metrics: `success`, `error`, `retried`, `terminated`. On publish metrics: `success`, `error`. On RPC round-trip metrics: `success`, `error`, `timeout`, `cancelled`.
- **`side`** on `jetstream_rpc_timeout_total`: `client` when the caller's deadline expired before a reply, `server` when a JetStream-mode handler ran past `rpc.timeout` and its command was terminated. Both carry the declared pattern, so a service that calls another one counts its timeouts under the pattern it called. Sum over `side` for the total the metric reported before.
- **`context`** on `jetstream_errors_total`: `connection`, `codec`, `publish`, `consume`, `handler`, `shutdown`, `other`.
- **`stream`** and **`consumer`** follow from the service name and kind; **`server`** is bounded by the cluster size.

The transport never adds an unbounded label itself. High-cardinality `defaultLabels`, such as per-request IDs, are yours to avoid.

## PromQL examples

Throughput, messages received per second by stream kind:

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

Alert when the NATS connection is down (add `for: 5m` to the alert rule to ignore blips):

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

- **Backpressure**: if the previous tick is still running when the next interval fires, the new tick is skipped and a warning is logged, so you can tell when the interval is too aggressive.
- **Per-target error isolation**: a failing `consumer.info()` increments `jetstream_metrics_poll_errors_total{target="consumer.info"}` without aborting the rest of the tick.
- **Shutdown**: `OnModuleDestroy` cancels the timer and awaits the in-flight tick.
- **Connection loss**: polling fails fast and increments the poll-error counter. Gauges go stale instead of dropping to zero, because the values are unknown.

Which consumers are polled:

- Event, broadcast and schedule consumers, when the service has handlers of that kind.
- The command consumer only in JetStream RPC mode; Core mode has no command stream.
- Never ordered consumers: they are ephemeral, with no durable name. Use `jetstream_messages_processed_total{kind="ordered"}` for ordered throughput.

## Performance characteristics

Per-message overhead with metrics enabled:

- 1× `performance.now()` at handler entry.
- 1× `EventBus.emit(HandlerCompleted, ...)` after settlement, which is a `Map.get` and a callback.
- 1× `PatternRegistry.resolveDeclared()` (a `Map.get`) inside the metrics service.
- 1× `Counter.inc()` + 1× `Histogram.observe()` in the Prometheus client.

Each is a constant-time call, small next to the NATS round-trip of the message itself.

Polling cost: one `consumer.info` and one `streams.info` per polled consumer every `pollInterval` ms. For a service with both event and RPC handlers in JetStream mode, that's roughly 0.27 NATS requests per second at the default 15s interval, negligible.

Memory grows with the number of label combinations, which is bounded: subject labels come from declared patterns, not from raw subjects (see [label values](#label-values)).

## Custom hooks alongside metrics

`metrics: true` does not replace your `hooks`: the transport delivers every event to both. The `HandlerCompleted`, `Published` and `RpcCompleted` events behind the counters are public, see [Lifecycle Hooks](/docs/guides/lifecycle-hooks).

## Multi-registry deployments

If your application exposes several `/metrics` endpoints, pass the `Registry` the transport should write to:

```ts
import { Registry } from '@prometheus-io/client';

const tenantRegister = new Registry();

JetstreamModule.forRoot({
  // ...
  metrics: { register: tenantRegister },
});
```

One `forRoot()` writes the metrics of all its connections to that one registry.
