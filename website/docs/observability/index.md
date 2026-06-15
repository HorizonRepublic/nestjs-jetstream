---
sidebar_position: 0
sidebar_label: "Overview"
title: "Observability — NestJS JetStream Transport"
description: "Built-in distributed tracing and Prometheus metrics for NATS JetStream. Trace individual messages end-to-end across services, and alert on aggregate health from a single /metrics endpoint."
schema:
  type: Article
  headline: "Observability — NestJS JetStream Transport"
  description: "Distributed tracing and Prometheus metrics built into the transport. Zero-config integration with OpenTelemetry SDKs and prom-client-based exporters."
  datePublished: "2026-05-27"
  dateModified: "2026-06-12"
---

# Observability

The transport ships with two complementary observability surfaces. Both work out of the box, both are designed for production, and both stay invisible when you don't need them.

[**Distributed tracing →**](/docs/observability/tracing) — answers "where did this one request go, and where did it slow down?" Backed by OpenTelemetry spans with W3C Trace Context propagation across services.

[**Prometheus metrics →**](/docs/observability/metrics) — answers "is the system healthy in aggregate? What should I alert on?" Backed by `prom-client` counters, histograms, and gauges written to a registry your exporter already serves.

## Picking what you need

**Reach for tracing when** debugging a specific request: a slow order, a dropped event, an RPC that failed in a weird way. A single trace shows the full path through `client.emit() -> consumer -> handler -> reply` across every service that touched the message.

**Reach for metrics when** running the system day to day: alert if consumer lag exceeds a threshold, dashboard p99 handler latency over time, get paged when the error rate spikes. Aggregated numbers — not individual requests — are what you want here.

Both surfaces complement each other. Most production deployments enable both: traces feed an APM (Sentry, Datadog, Jaeger, Tempo, Honeycomb), metrics feed a Prometheus + Grafana stack, and alerts route through both depending on whether the symptom is "this one request" or "the whole system."

## Zero overhead when disabled

Neither surface costs anything when off:

- **Tracing**: with no OpenTelemetry SDK registered in the host application, every tracer call inside the transport short-circuits to a no-op. `@opentelemetry/api` is an optional peer; nothing in the library forces it into your bundle.
- **Metrics**: with `metrics` omitted from `forRoot`, the metrics module is never registered. `prom-client` is never imported; not even dynamically. Per-message overhead drops to a single `Map.get` (~30 nanoseconds) that checks whether anyone is listening.

You can enable either independently, or both. They share the same `EventBus` for transport events but are otherwise isolated.

## Quick start

```ts
// 1. Tracing — register any OpenTelemetry SDK before your AppModule loads.
// Sentry, Datadog, NewRelic, or @opentelemetry/sdk-node — pick one.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
new NodeSDK({
  serviceName: 'orders-service',
  traceExporter: new OTLPTraceExporter({ url: 'http://collector:4318/v1/traces' }),
}).start();

// 2. Metrics — enable in forRoot.
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';

@Module({
  imports: [
    PrometheusModule.register(),
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['nats://localhost:4222'],
      metrics: true,
    }),
  ],
})
export class AppModule {}
```

Continue with [Tracing](/docs/observability/tracing) for OpenTelemetry details and [Metrics](/docs/observability/metrics) for the full Prometheus catalog.
