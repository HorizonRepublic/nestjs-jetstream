---
sidebar_position: 6
sidebar_label: "Release Notes"
title: "Release Notes: NestJS JetStream Transport"
description: "Version-by-version changelog: new features, behavior changes, peer dependencies, and breaking changes between releases of @horizon-republic/nestjs-jetstream."
schema:
  type: Article
  headline: "Release Notes: NestJS JetStream Transport"
  description: "Version-by-version changelog covering new features, behavior changes, and breaking changes."
  datePublished: "2026-03-26"
  dateModified: "2026-08-03"
---

# Release Notes

Version-by-version changelog. New features, peer-dependency requirements, behavior changes, and the small list of breaking changes are tracked here. For instructions on how to switch from the built-in `@nestjs/microservices` NATS transport to this library, see the [Migration Guide](/docs/guides/migration).

## v2.13 → v3.0

**New features**

- [**Multiple connections**](/docs/guides/multi-connection): one service can talk to several NATS clusters through a `connections` map, each with its own streams, consumers, routers and backpressure budget. Bind a controller with `@JetstreamConnection('name')` or a single handler with `{ connection }` in the pattern extras, publish through `forFeature({ connection })`, and attach every connection at bootstrap with `connectJetstreamMicroservices(app)`. Mark a connection `critical: false` and a dead secondary cluster degrades health instead of blocking startup.
- **Health reports per connection.** `check()` gains `degraded` and a `connections` breakdown once more than one connection is configured. `connected` now means "every critical connection is alive", so `isHealthy()` keeps passing while a non-critical cluster is down.
- **Shutdown drains connections in parallel.** Every connection stops accepting before any of them drains, and each is bounded by its own `shutdownTimeout`, so the ceiling for SIGTERM is `max(timeouts)` rather than their sum.
- **Colliding connections fail fast.** Two connections that resolve the same stream are caught at startup, either by their server sets matching or by the `nestjs-jetstream-owner` stamp the transport writes into stream metadata.

**Behavior changes**

- **Streams reserve far less storage.** `max_bytes` drops to 512 MB on events, 1 GB on ordered, 256 MB on broadcast and 64 MB on commands, and `max_msg_size` drops to 1 MB. `max_bytes` is mutable, so existing streams pick the new value up on the next boot.
- **Retries are paced.** A failing handler naks with a delay from `[2000, 10000]` ms instead of immediately. Pass `events: { retry: false }` for the previous behavior.
- **The dead-letter stream is on by default**, so exhausted messages land in `{service}__microservice_dlq-stream` instead of being dropped. Pass `dlq: false` to opt out.
- **Streams gain an ownership stamp.** Every service-scoped stream, the DLQ included, carries `nestjs-jetstream-owner` metadata. Existing streams pick it up through one mutable update on the first boot after upgrading; the shared broadcast stream is never stamped.
- **Hooks receive a trailing connection name**, populated only when more than one connection is configured. Hooks that ignore the extra argument are unaffected.

**Breaking changes**

- **Node 20 is no longer supported.** The minimum is Node 22.
- **`servers` is optional in the options type**, paired with the mutually exclusive `connections`. Supplying both, or neither, fails at startup. Flat configurations keep working untouched.

A single-connection application upgrades with no source changes: stream, consumer and subject names are identical, `check()` returns the same shape, and hook payloads are unchanged. See [Upgrading between versions](/docs/guides/migration#upgrading-between-versions) for the step-by-step notes.

## Earlier releases

Every 2.x release, newest first.

<details>
<summary>v2.12 → v2.13</summary>

**New features**

- [**Bring your own infrastructure**](/docs/guides/external-infrastructure): `provisioning: { management: ManagementMode.Manual }` binds to streams and consumers provisioned by Terraform, ArgoCD, or a platform team. The transport validates what it finds and never creates or updates it.
- **Custom names are honored.** `stream.name`, `consumer.durable_name` and subject prefixes set in a kind's overrides are now read and applied, instead of being silently ignored in favor of the naming conventions.

**Behavior changes**

- If you had `stream.name` or `consumer.durable_name` set by accident, the transport now uses those names instead of the convention-derived ones. Review your `overrides` blocks before upgrading.

**Bug fixes**

- Consumer filters that would swallow scheduled messages are rejected at boot rather than silently dropping them.
- Unfiltered consumers are treated as covering every handler subject, so binding to them no longer fails validation.
- Self-RPC, broadcast publishing and metric labels all resolve names through the same resolver, so custom names apply consistently.

</details>

<details>
<summary>v2.11 → v2.12</summary>

**New features**

- **Provisioning boot summary and actionable errors.** Startup logs what each stream reserves, and provisioning failures name the entity, the limits involved, and what to do about it. Opt into a storage preflight to catch an over-committed file store before it bites.

**Bug fixes**

This release closed a set of silent data-loss and reliability gaps. The ones worth knowing about:

- **Destructive stream migration no longer has data-loss windows**, and services can no longer clobber the shared broadcast stream.
- **Routers subscribe before consumers start delivering**, so a consumer flushing its backlog at startup no longer drops messages onto a subject nobody is watching yet.
- **Dead-letter handling engages when `dlq` is configured without `onDeadLetter`**, unroutable messages are captured in the DLQ instead of being terminated, and `ctx.retry()` on the final delivery escalates to dead-letter handling rather than vanishing.
- **The DLQ publish is retried in-process**, and the transport no longer promises redelivery it cannot make.
- **Ack extension keeps running for backlogged messages**, and settlement failures on a degraded connection are contained instead of taking the pipeline down.
- **Scheduling fixes:** per-message TTL applies to the delivered message rather than the schedule holder, each scheduled message goes to a unique subject, and `scheduleAt` is rejected for ordered patterns.
- **NATS control headers set by user code are blocked** and stripped from DLQ republishes.
- The DLQ stream retention changed to `Limits`, and empty payloads decode as `undefined`.

</details>

<details>
<summary>v2.10 → v2.11</summary>

**New features**

- [**Prometheus metrics**](/docs/observability/metrics): built-in `prom-client`-based metrics covering throughput (`jetstream_messages_received_total`, `jetstream_publish_total`, `jetstream_messages_dead_letter_total`), latency histograms (`jetstream_handler_duration_seconds`, `jetstream_publish_duration_seconds`, `jetstream_rpc_duration_seconds`), and consumer lag gauges (`jetstream_consumer_num_pending`, `jetstream_stream_messages`, etc.). Enable via `forRoot({ metrics: true })`. Writes to `prom-client`'s global `register` by default, so pairing with `@willsoto/nestjs-prometheus` is zero-config. Adds `TransportEvent.HandlerCompleted`, `TransportEvent.Published`, and `TransportEvent.RpcCompleted` to the public `TransportHooks` surface for users who want to subscribe directly.

**Peer dependency (optional)**

- **`prom-client`** is now declared as an **optional peer dependency** (`^15.0.0`). Required only when `metrics` is enabled. The transport never imports it when `metrics` is omitted or `false`, so applications that do not use the metrics feature pay nothing: zero bundle weight and zero runtime cost.

**Documentation reorganization**

- The `Distributed Tracing` guide moved from `/docs/guides/distributed-tracing` to **`/docs/observability/tracing`**. The new top-level **Observability** section in the sidebar groups both tracing and metrics under a single heading with a shared overview page. Bookmarks and external links to the old path should be updated.

No breaking API changes. Existing applications upgrade by bumping the dependency.

</details>

<details>
<summary>v2.9 → v2.10</summary>

**New features**

- [**Distributed tracing with OpenTelemetry**](/docs/observability/tracing): every publish, consume, and RPC round-trip now produces an OpenTelemetry span. W3C Trace Context propagates through NATS message headers, so a single trace flows end-to-end across services. Activates automatically the moment your application registers an OpenTelemetry SDK (Sentry, Datadog, NodeSDK, etc.); zero runtime cost when no SDK is registered. Configurable through `forRoot({ otel: ... })`.
- [**Header contract**](/docs/reference/header-contract): formal documentation of the NATS message headers the transport reads and writes. Use this as the integration spec when publishing to (or consuming from) the transport from other languages (Go, Python, etc.).

**Peer dependency (optional)**

- **`@opentelemetry/api`** is now declared as an **optional peer dependency**. Applications that already register an OpenTelemetry SDK (`@sentry/node`, `@datadog/tracer`, `@opentelemetry/sdk-node`, etc.) bring it in transitively; no action needed. Applications that want to use the library's distributed-tracing feature and do not already have an OTel SDK must install `@opentelemetry/api` at the same major version (`^1.9.0`). This avoids the silent "no-op tracer" trap where two copies of the API live in `node_modules` and the global tracer singleton refuses the mismatched version.

**Behavior changes (non-breaking API, observable in logs/APM)**

- **Reduced internal logging.** The `logger.error` sites that duplicated existing `TransportHooks` events have been removed. The hook is now the single observability channel for those events. If you relied on those log lines for monitoring, register the relevant hook (`error`, `rpcTimeout`, `deadLetter`).
- **Error classification on OTel spans.** When OpenTelemetry is enabled, handler throws of `RpcException` and `HttpException` produce `OK` spans with `jetstream.rpc.reply.has_error` and `jetstream.rpc.reply.error.code` attributes; they are treated as expected business outcomes per the RPC contract. Bare `Error` throws produce `ERROR` spans with `recordException`. This keeps APM error rates clean for known business denials while loud-failing on real bugs.
- **TransportEvent.Error now fires on every handler throw**, both event and RPC paths. Previously only some paths emitted it. If you have an `error` hook registered, it will now receive these (which is what most users want).
- **`RpcConfig.timeout` in JetStream mode now bounds `connect + RPC`.** Previously the JetStream-mode per-request deadline only started after `await connect()` resolved, which meant a permanent NATS outage could accumulate pending RPCs indefinitely. The deadline is now armed immediately so callers always see a timeout. Core-mode RPC still relies on `nats.js`'s own `nc.request({ timeout })`, which starts after `connect()` resolves; operators running permanent-outage scenarios against Core mode should configure `maxReconnectAttempts` to stop the retry loop at the protocol layer.

No breaking API changes. Existing applications upgrade by bumping the dependency.

</details>

<details>
<summary>v2.8 → v2.9</summary>

**Notable change**

:::warning Broadcast `max_age` reduced: 1 day → 1 hour
Broadcast messages (config propagation, cache invalidation, feature flags) are relevant for minutes, not days. The new default provides a enough catch-up window while reducing storage. This is a mutable property, **existing streams update automatically on next application startup**. If you need a longer retention window, override it explicitly:

```typescript
broadcast: { stream: { max_age: toNanos(1, 'days') } }
```

:::

**New features**

- [**Built-in Dead Letter Queue stream**](/docs/guides/dead-letter-queue#built-in-dlq-stream): add the `dlq: { stream }` option to `forRoot()` and the library provisions a dedicated DLQ stream on startup. Exhausted messages are automatically republished with tracking headers (`x-dead-letter-reason`, `x-original-subject`, `x-original-stream`, `x-failed-at`, `x-delivery-count`). The `onDeadLetter` callback remains available as a standalone option or as a notification/safety-net hook when combined with the DLQ stream.
- [**Per-message TTL**](/docs/guides/per-message-ttl): `JetstreamRecordBuilder.ttl(duration)` sets the `Nats-TTL` header (NATS 2.11+), allowing individual messages to expire independently of the stream's `max_age`. Requires `allow_msg_ttl: true` on the target stream.
- [**Handler metadata registry (NATS KV)**](/docs/patterns/handler-metadata): when enabled via the `metadata` option, the library publishes all registered `@EventPattern` / `@MessagePattern` handlers to a NATS KV bucket at startup, enabling cross-service discovery without a separate service registry.
- [**Stream migration**](/docs/guides/stream-migration): automatic blue-green stream recreation for immutable property changes (`storage`, `retention`, etc.). Enable with `allowDestructiveMigration: true` on a per-stream basis.
- **Consumer self-healing auto-recreation**: consumers deleted externally (via NATS CLI, cluster issues) are automatically recreated on the next poll. Migration-aware: waits during active stream migrations.
- **`StreamConfigOverrides` type**; prevents users from overriding `retention` (transport-controlled).
- **`NatsErrorCode` enum** for NATS JetStream API error codes, so error handling code can switch on typed constants instead of magic strings.

No breaking changes.

</details>

<details>
<summary>v2.7 → v2.8</summary>

**Breaking change:** migrated from `nats` package to `@nats-io/*` scoped packages (v3.x).

This is an internal change: the library re-exports everything users need. If you import types directly from `nats` in your own code, update them:

```diff
- import { JsMsg, NatsConnection } from 'nats';
+ import { JsMsg } from '@nats-io/jetstream';
+ import { NatsConnection } from '@nats-io/transport-node';
```

**New features**

- [Message scheduling](/docs/guides/scheduling): one-shot delayed delivery via `scheduleAt()` (requires NATS >= 2.12)
- `allow_msg_schedules` stream config option

</details>

<details>
<summary>v2.6 → v2.7</summary>

v2.7 shipped handler-controlled settlement, a way to ack, nak, or terminate a message without throwing.

**New features**

- Handler-controlled settlement via [`ctx.retry()` and `ctx.terminate()`](/docs/guides/handler-context#controlling-message-settlement): control message acknowledgment without throwing errors
- Metadata getters on [`RpcContext`](/docs/guides/handler-context#jetstream-message-info): `getDeliveryCount()`, `getStream()`, `getSequence()`, `getTimestamp()`, `getCallerName()`

No breaking changes.

</details>

<details>
<summary>v2.5 → v2.6</summary>

v2.6 was the performance release, concurrency control, ack extension, and reworked defaults for reconnection and compression.

**New features**

- Configurable [concurrency](/docs/guides/performance#concurrency-control) for event/broadcast/RPC processing
- [Ack extension](/docs/guides/performance#ack-extension) (`ackExtension: true`) for long-running handlers
- Consume options passthrough for advanced prefetch tuning
- Heartbeat monitoring with automatic consumer restart
- S2 stream compression enabled by default (see [Stream Defaults](/docs/reference/default-configs#stream-defaults))
- Performance connection defaults (unlimited reconnect, 1s interval)

No breaking changes.

</details>

<details>
<summary>v2.4 → v2.5</summary>

**Breaking change:** `nanos()` renamed to `toNanos()`.

```diff
- import { nanos } from '@horizon-republic/nestjs-jetstream';
+ import { toNanos } from '@horizon-republic/nestjs-jetstream';

  consumer: {
-   ack_wait: nanos(30, 'seconds'),
+   ack_wait: toNanos(30, 'seconds'),
  }
```

</details>

<details>
<summary>v2.3 → v2.4</summary>

**New features**

- Ordered events (`ordered:` prefix, `DeliverPolicy` options)
- Custom message IDs via `setMessageId()` for publish-side deduplication
- Documentation site (Docusaurus)

No breaking changes.

</details>

<details>
<summary>v2.1 → v2.2</summary>

**New features**

- Dead letter queue support via `onDeadLetter` callback
- `DeadLetterInfo` interface with full message context

No breaking changes.

</details>

## See also

- [Migration Guide](/docs/guides/migration): switching from `@nestjs/microservices` NATS to this library
- [GitHub Releases](https://github.com/HorizonRepublic/nestjs-jetstream/releases): full change history with commit-level detail
