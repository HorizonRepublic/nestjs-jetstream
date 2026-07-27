---
sidebar_position: 0
sidebar_label: "Why JetStream?"
title: "Why JetStream? NestJS NATS Transport Comparison"
description: "When the built-in NestJS NATS transport is enough, and when your system outgrows Core NATS and needs JetStream for durable messaging."
schema:
  type: Article
  headline: "Why JetStream? NestJS NATS Transport Comparison"
  description: "When the built-in NestJS NATS transport is enough, and when your system outgrows Core NATS and needs JetStream for durable messaging."
  datePublished: "2026-04-11"
  dateModified: "2026-07-27"
---

# Why JetStream?

The [built-in NestJS NATS transport](https://docs.nestjs.com/microservices/nats) runs on Core NATS: fire-and-forget pub/sub with no persistence. This page marks the line where that stops being enough.

## Stay on the built-in transport when

- Messages are idempotent hints: cache invalidations, notification fan-out, metric updates.
- Losing one is acceptable, because retrying or recomputing is cheap.
- No consumer needs history.
- Latency is the thing you tune for, ahead of durability.

Persistence costs disk I/O, stream provisioning and consumer state. If the list above describes your workload, stop here.

## Where Core NATS drops messages

| Situation                                     | Core NATS                                        | With this library                                                                          |
| --------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Pod gets `SIGTERM` with 40 messages in flight | All 40 are gone: the publisher was already acked | Messages return to pending, the next pod takes them                                        |
| Downstream is down for 3 minutes              | 200 events delivered into the void               | Events wait in the stream, processed in order on return                                    |
| Handler throws on a specific payload          | Lost on the first throw                          | Retried to `max_deliver` (default 3), then written to the DLQ stream with tracking headers |
| New service needs the last 7 days             | Custom backfill job against the database         | A consumer with `deliver_policy` by start time replays the stream                          |
| New replica missed a broadcast during startup | No answer                                        | Per-service durable consumers catch it up                                                  |

The first row needs one line from you: call `app.enableShutdownHooks()` so NestJS runs the shutdown lifecycle. See [Graceful Shutdown](../guides/graceful-shutdown) and [Dead Letter Queue](../guides/dead-letter-queue).

## What the library adds over raw JetStream

Driving JetStream from the `@nats-io/*` packages directly means building this yourself:

**Delivery**

- [Workqueue events](../patterns/events): at-least-once, one handler instance per message
- [Broadcast events](../patterns/broadcast): fan-out to every subscribing service
- [Ordered events](../patterns/ordered-events): strict sequence over ephemeral consumers
- [RPC](../patterns/rpc) in Core or JetStream mode

**Durability and recovery**

- [Dead letter queue](../guides/dead-letter-queue) for messages that exhaust every retry
- [Stream migration](../guides/stream-migration) for locked settings such as storage type
- [Self-healing consumers](../reference/edge-cases#consumer-self-healing) after broker restarts and external deletion
- [Graceful shutdown](../guides/graceful-shutdown) that drains in-flight work first

**Publishing**

- [Per-message TTL](../guides/per-message-ttl)
- [Scheduled delivery](../guides/scheduling) through NATS 2.12 headers
- [Deduplication by deterministic message ID](../guides/record-builder)
- [Publisher-only mode](../reference/edge-cases#publisher-only-mode) for gateways

**Operations**

- [Health indicator](../guides/health-checks) for Kubernetes probes
- [Lifecycle hooks](../guides/lifecycle-hooks) for metrics, tracing and alerting
- [Handler metadata registry](../patterns/handler-metadata) over NATS KV
- [Ack extension](../guides/performance#ack-extension) for handlers slower than `ack_wait`

Every item sits behind `@EventPattern`, `@MessagePattern` and `ClientProxy`.

## HTTP, Core NATS or JetStream

|           | Best at                              | Cost                                                                      |
| --------- | ------------------------------------ | ------------------------------------------------------------------------- |
| HTTP      | Request/response with mature tooling | Couples caller and callee in time; retries and circuit breakers are yours |
| Core NATS | Low-latency in-cluster RPC           | No persistence                                                            |
| JetStream | Work that must not be lost           | Disk I/O, stream and consumer state                                       |

Most systems run all three: HTTP at the edge, Core NATS for hot internal calls, JetStream for durable events. RPC mode is per module (`rpc.mode: 'core'` or `'jetstream'`) while `@EventPattern` stays on durable delivery.

## Other NestJS NATS packages

| Package                                                                                                                            | Focus                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`@nestjs/microservices`](https://docs.nestjs.com/microservices/nats)                                                              | Official Core NATS integration, maintained by the NestJS team              |
| [`@nestjs-plugins/nestjs-nats-jetstream-transport`](https://www.npmjs.com/package/@nestjs-plugins/nestjs-nats-jetstream-transport) | Community JetStream transport                                              |
| [`@mirasys/nestjs-jetstream-transporter`](https://www.npmjs.com/package/@mirasys/nestjs-jetstream-transporter)                     | Custom JetStream transporter                                               |
| `@horizon-republic/nestjs-jetstream`                                                                                               | This library: DLQ, health indicators, broadcast, ordered delivery, tracing |

## Don't use this library when

- **You don't run NATS.** Operating it costs real time; solve the problem you have now.
- **Your workload is request/response without durability.** The built-in transport is lighter.
- **You need cross-region replication under strict latency SLAs.** Mirrors and sources exist, though tuning them for multi-region is its own project.
- **You're prototyping.**

## Next

- [Installation](./installation)
- [Quick Start](./quick-start): the four-step example
- [Events](../patterns/events) and [RPC](../patterns/rpc): the patterns you use daily
- [Module Configuration](/docs/reference/module-configuration), [DLQ](/docs/guides/dead-letter-queue), [Health Checks](/docs/guides/health-checks), [Graceful Shutdown](/docs/guides/graceful-shutdown)
