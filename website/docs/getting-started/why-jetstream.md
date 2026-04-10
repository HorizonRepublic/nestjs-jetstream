---
sidebar_position: 0
title: Why JetStream?
description: When the built-in NestJS NATS transport is enough, and when you need JetStream for production-grade messaging.
schema:
  type: Article
  headline: "Why JetStream?"
  description: "When the built-in NestJS NATS transport is enough, and when you need JetStream for production-grade messaging."
  datePublished: "2026-04-11"
  dateModified: "2026-04-11"
---

# Why JetStream?

NestJS ships with a [built-in NATS transport](https://docs.nestjs.com/microservices/nats) that works great for a specific class of problems. This page explains where that transport stops being enough, and what JetStream solves in its place.

The goal isn't to replace the official transport — it's to help you recognize the moment when your system outgrows Core NATS and needs a persistence layer underneath.

## When the built-in NATS transport is enough

The official `@nestjs/microservices` NATS transport is built on Core NATS — a fast, fire-and-forget pub/sub layer. It's a solid choice when:

- **All your services run in the same cluster** and restart rarely.
- **Messages are idempotent hints**, not commands that must be executed exactly once. Cache invalidations, notification fan-out, metric updates.
- **Losing a message is acceptable** — retrying later or recomputing state is cheap.
- **You don't need replay** — new consumers don't care about historical messages.
- **Latency matters more than durability** — you want sub-millisecond round trips and are willing to trade reliability for speed.

If this describes your workload, stop here. Use the built-in transport. Adding persistence has real costs: disk I/O, stream provisioning, consumer state to manage.

## When you outgrow Core NATS

Most production systems eventually hit a scenario where Core NATS silently loses data. These are the moments that motivate a switch.

### Scenario 1 — Deploy kills in-flight messages

You roll out a new version. Kubernetes sends `SIGTERM` to the old pod while it's processing 40 messages. With Core NATS, those 40 messages are gone — the publisher already got its "delivered" ack, but no handler finished them. Nobody notices until a customer opens a ticket.

With JetStream, messages stay in the stream until a handler **explicitly acks** them. When the pod dies, the messages go back to pending and the next pod picks them up. Zero loss, no code changes in your publishers.

This library enforces this guarantee automatically — handlers ack on successful return, nak on thrown errors, and the module drains in-flight work before the NATS connection closes. One caveat: make sure to call `app.enableShutdownHooks()` in your bootstrap so NestJS triggers the shutdown lifecycle. See [Graceful Shutdown](../guides/graceful-shutdown) for the full flow.

### Scenario 2 — Downstream service is down for 3 minutes

Your payment service restarts. During the window, 200 "order placed" events try to reach it. Core NATS delivers them into the void — no subscriber, no problem, messages vanish.

With JetStream, those 200 events sit in the stream. When the payment service comes back up, it processes them in order, from where it left off. No outbox pattern, no retry queue, no custom replay logic.

### Scenario 3 — A handler keeps failing

A bug in your email sender throws on a specific payload. With Core NATS, the message is lost on the first throw. With raw JetStream, the message redelivers forever, blocking the queue.

This library gives you **bounded retries** (`max_deliver`) plus a first-class [Dead Letter Queue](../guides/dead-letter-queue): configure `dlq: { stream }` and exhausted messages are automatically republished to a dedicated DLQ stream with tracking headers (original subject, failure reason, delivery count, timestamp). An `onDeadLetter` callback hook is also available — either standalone for custom persistence, or as a safety net when the DLQ publish itself fails. Nothing is silently dropped.

### Scenario 4 — A new service needs historical data

You ship a new analytics service that needs the last 7 days of orders. With Core NATS, you write a custom backfill job that queries the database and replays events. With JetStream, you create a new consumer on the existing stream with a `deliver_policy` of "by start time" — and the stream feeds your new consumer the entire history automatically.

### Scenario 5 — Every instance must see every message

You run three replicas of a cache service and each one needs to invalidate its local cache on every config change. Core NATS pub/sub actually handles this well. But when you add "the new replica that just spun up needs the last change it missed during startup" — Core NATS has no answer.

This library provides a dedicated [Broadcast](../patterns/broadcast) pattern: per-service durable consumers over a shared stream, so every replica catches up on missed broadcasts automatically after startup.

## What this library adds on top of raw JetStream

JetStream itself is a protocol. Using it from Node.js directly with the `@nats-io/*` client packages works, but you'd rebuild a lot of infrastructure before you could focus on business logic. Here is what the library provides out of the box — each bullet is a link to the dedicated page:

**Delivery patterns**
- [Workqueue events](../patterns/events) — at-least-once delivery with one handler instance per message
- [Broadcast events](../patterns/broadcast) — fan-out to every subscribing service
- [Ordered events](../patterns/ordered-events) — strict sequential delivery with ephemeral consumers
- [RPC (Core or JetStream mode)](../patterns/rpc) — synchronous request/reply with configurable persistence

**Message durability & recovery**
- [Dead Letter Queue stream](../guides/dead-letter-queue) with tracking headers and a fallback callback chain
- [Stream migration](../guides/stream-migration) with blue-green sourcing for immutable property changes
- [Self-healing consumers](../reference/edge-cases#consumer-self-healing) that recover automatically from broker restarts and external deletions
- [Graceful shutdown](../guides/graceful-shutdown) with in-flight message drain

**Publisher features**
- [Per-message TTL](../guides/per-message-ttl) for individual message expiration
- [Scheduled delivery](../guides/scheduling) via NATS 2.12 scheduling headers
- [Deduplication via deterministic message IDs](../guides/record-builder) through the built-in `JetstreamRecordBuilder`
- [Publisher-only mode](../reference/edge-cases#publisher-only-mode) for API gateways

**Operations**
- [Health indicator](../guides/health-checks) for Kubernetes readiness/liveness probes
- [Lifecycle hooks](../guides/lifecycle-hooks) for metrics, tracing, and alerting
- [Handler metadata registry](../patterns/handler-metadata) backed by NATS KV for cross-service discovery
- [Ack extension](../guides/performance#ack-extension) for long-running handlers

All of this is wrapped behind the same NestJS decorators you already use (`@EventPattern`, `@MessagePattern`, `ClientProxy`), so moving from the built-in transport to JetStream is mostly a configuration change, not a rewrite.

## When HTTP is the wrong question

Teams sometimes ask "should I use HTTP or NATS for service-to-service calls?". It's the wrong framing — the two protocols optimize for different things.

- **HTTP** is great at request/response with well-defined endpoints, easy debugging, and mature tooling. But it couples caller and callee in time: if the callee is down, the call fails. Retries, circuit breakers, and timeouts become your problem.
- **NATS (Core)** is great at low-latency RPC between in-cluster services. Multiplexed connections, no connection pooling, microsecond latency.
- **NATS (JetStream)** is great at asynchronous work that must not be lost: events, commands, integrations with unreliable downstreams.

In practice, most production systems use all three. HTTP at the edge (ingress from browsers), Core NATS for internal low-latency RPC, JetStream for durable events and workflows. This library lets you configure the RPC mode per module (`rpc.mode: 'core'` for hot paths, `rpc.mode: 'jetstream'` for persisted commands) while `@EventPattern` handlers keep using durable JetStream delivery.

## The NestJS + NATS ecosystem

You have several options when connecting NestJS to NATS. Each project has its own focus, and the right choice depends on your workload. Listed in order of longevity in the ecosystem:

- **[`@nestjs/microservices`](https://docs.nestjs.com/microservices/nats) (built-in NATS transport)** — the official, lean Core NATS integration maintained by the NestJS core team. A solid default for low-latency in-cluster RPC and fire-and-forget pub/sub.
- **[`@nestjs-plugins/nestjs-nats-jetstream-transport`](https://www.npmjs.com/package/@nestjs-plugins/nestjs-nats-jetstream-transport)** — a community-maintained JetStream transport for NestJS microservices.
- **[`@mirasys/nestjs-jetstream-transporter`](https://www.npmjs.com/package/@mirasys/nestjs-jetstream-transporter)** — a custom JetStream transporter for NestJS.
- **`@horizon-republic/nestjs-jetstream`** *(this library)* — a JetStream transport with a focus on production readiness: built-in DLQ, health indicators, and broadcast delivery.

All of these projects are active parts of the NATS + NestJS ecosystem and we encourage you to compare them against your own requirements. If your workload fits one of the other options better, use it — what matters is that the community keeps growing.

## When NOT to use this library

Being honest about trade-offs matters. Don't use this library if:

- **You don't run NATS.** Adding NATS + JetStream is a real operational commitment. If your team doesn't already operate it, start with the problem you have today, not the one you might have tomorrow.
- **Your workload is pure request/response with no durability needs.** The built-in transport is lighter and faster for that case.
- **You need cross-region replication with strict latency SLAs.** JetStream mirrors and sources exist, but tuning them for multi-region is non-trivial. Evaluate carefully.
- **You're prototyping.** Reach for the simplest thing until you have a real reliability problem.

## Next steps

- Install the package and connect to a local NATS broker — [Installation](./installation)
- Run the full four-step example in under five minutes — [Quick Start](./quick-start)
- Explore the patterns you'll use daily — [Events](../patterns/events), [RPC](../patterns/rpc)
- Skim the production checklist — [Module Configuration](./module-configuration), [DLQ](../guides/dead-letter-queue), [Health Checks](../guides/health-checks), [Graceful Shutdown](../guides/graceful-shutdown)
