---
sidebar_position: 0
sidebar_label: "Overview"
title: "Observability: NestJS JetStream Transport"
description: "Built-in distributed tracing and Prometheus metrics for NATS JetStream. Trace individual messages end-to-end across services, and alert on aggregate health from a single /metrics endpoint."
schema:
  type: Article
  headline: "Observability: NestJS JetStream Transport"
  description: "Distributed tracing and Prometheus metrics built into the transport. Zero-config integration with OpenTelemetry SDKs and Prometheus client exporters."
  datePublished: "2026-05-27"
  dateModified: "2026-10-23"
---

# Observability

> **Use when:** you are deciding between tracing and metrics, or want both running.
> **You get:** what each surface answers, what it costs when off, and a setup that enables both.

| Surface                                            | Answers                                                    | Built on                                                                 | Default                                |
| -------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| [Distributed tracing](/docs/observability/tracing) | Where did this one request go, and where did it slow down? | OpenTelemetry spans, W3C Trace Context across services                   | on, a no-op until an SDK is registered |
| [Prometheus metrics](/docs/observability/metrics)  | Is the system healthy in aggregate, and what to alert on?  | `@prometheus-io/client` or `prom-client` counters, histograms and gauges | off until `metrics` is set             |

Use tracing to debug one request: a single trace shows `client.emit() -> consumer -> handler -> reply` across every service that touched the message. Use metrics to run the system day to day: consumer lag, p99 handler latency, error rate, throughput per kind. Most production deployments run both, traces into an APM (Sentry, Datadog, Jaeger, Tempo, Honeycomb) and metrics into Prometheus and Grafana.

## Zero overhead when disabled

- **Tracing**: with no OpenTelemetry SDK registered in the host application, every tracer call short-circuits to a no-op.
- **Metrics**: with `metrics` omitted, the metrics module is never registered and no Prometheus client is imported. Per-message overhead is one `Map.get` that finds no listener.

The two are independent; they share only the `EventBus` that carries transport events.

## Quick start

```ts
// 1. Tracing: register any OpenTelemetry SDK (Sentry, Datadog, New Relic,
// @opentelemetry/sdk-node) before AppModule loads.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
new NodeSDK({
  serviceName: 'orders-service',
  traceExporter: new OTLPTraceExporter({ url: 'http://collector:4318/v1/traces' }),
}).start();

// 2. Metrics: enable in forRoot.
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

[Tracing](/docs/observability/tracing) covers the OpenTelemetry options and span catalog, [Metrics](/docs/observability/metrics) the Prometheus catalog.
