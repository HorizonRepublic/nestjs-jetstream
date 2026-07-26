---
slug: /
sidebar_position: 1
sidebar_label: "Introduction"
title: "NestJS NATS Transport with JetStream: Introduction"
description: "A NestJS NATS microservice transport backed by JetStream: durable events, broadcast, ordered delivery, RPC, and dead letter queues."
schema:
  type: Article
  headline: "NestJS NATS Transport with JetStream: Introduction"
  description: "A NestJS NATS microservice transport backed by JetStream: durable events, broadcast, ordered delivery, RPC, and dead letter queues."
  datePublished: "2026-03-21"
  dateModified: "2026-07-27"
---

# What do you need right now?

NestJS' [built-in NATS transport](https://docs.nestjs.com/microservices/nats) loses messages on pod restart, never retries, and leaves nothing to debug with. This library keeps the decorators and changes what happens underneath: durability, bounded retries, dead letters and W3C tracing.

Three doors, by situation. The full map is in the sidebar.

## "Is this production-ready?"

[Why JetStream?](/docs/getting-started/why-jetstream) states the trade-offs, the cases where the built-in transport is enough on its own, and where Core NATS drops messages. [Testing](/docs/development/testing) covers what the suite exercises against a real NATS server.

## "I need the exact key"

[Module configuration](/docs/reference/module-configuration) for every option and default, [header contract](/docs/reference/header-contract) for every header the transport reads and writes, [default configs](/docs/reference/default-configs) for the stream and consumer values you inherit. Or press <kbd>⌘K</kbd> and type the name.

## "Something is wrong in prod"

By symptom:

| Symptom                       | Start here                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Messages disappear on deploy  | [Graceful shutdown](/docs/guides/graceful-shutdown)                                                                        |
| Consumer lag climbing         | [Consumer issues](/docs/guides/troubleshooting#consumer-issues), [performance](/docs/guides/performance)                   |
| Everything dead-letters       | [Dead letter queue](/docs/guides/dead-letter-queue), [DLQ troubleshooting](/docs/guides/troubleshooting#dead-letter-queue) |
| RPC calls time out            | [RPC issues](/docs/guides/troubleshooting#rpc-issues)                                                                      |
| Handlers never fire           | [Startup issues](/docs/guides/troubleshooting#startup-issues)                                                              |
| Stream config change rejected | [Stream migration](/docs/guides/stream-migration)                                                                          |

## New here

[Quick start](/docs/getting-started/quick-start) gets a consumer running in ten minutes, then [events](/docs/patterns/events) is the delivery pattern everything else builds on. Coming from the built-in transport, [migrating](/docs/guides/migration) maps each old option to its replacement.

:::tip Runnable examples
The repository ships [ten self-contained demos](https://github.com/HorizonRepublic/nestjs-jetstream/tree/main/examples): events, RPC, ordered delivery, DLQ, health checks, scheduling, publisher-only mode, per-message TTL, handler metadata and distributed tracing. Clone and run.
:::
