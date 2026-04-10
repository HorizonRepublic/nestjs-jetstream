---
slug: /
sidebar_position: 1
sidebar_label: "Introduction"
title: "NestJS NATS Transport with JetStream — Introduction"
description: "A NestJS NATS microservice transport backed by JetStream: durable events, broadcast, ordered delivery, RPC, and dead letter queues."
schema:
  type: Article
  headline: "NestJS NATS Transport with JetStream — Introduction"
  description: "A NestJS NATS microservice transport backed by JetStream: durable events, broadcast, ordered delivery, RPC, and dead letter queues."
  datePublished: "2026-03-21"
  dateModified: "2026-04-11"
---

# Introduction

**`@horizon-republic/nestjs-jetstream`** is a NestJS NATS transport for production microservices. It wraps [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) under the same `@EventPattern` / `@MessagePattern` decorators you already use, so messages survive pod restarts, retries are bounded, dead letters have a home, and everything plugs into the standard NestJS lifecycle.

The [built-in NestJS NATS transport](https://docs.nestjs.com/microservices/nats) is fire-and-forget: if a pod dies mid-handler the message is gone. Retries, replay, and dead letter handling are left to you. This library gives you all of that out of the box by putting JetStream underneath.

For a side-by-side with the built-in transport and the scenarios that force the switch, read [**Why JetStream?**](/docs/getting-started/why-jetstream).

## Architecture at a glance

```text
 Your NestJS Application
 +--------------------------+
 |  HTTP Controllers        |    client.emit() / client.send()
 |  (AppController)         | ──────────────────┐
 +--------------------------+                    │
                                                 ▼
 +--------------------------+    ┌──────────────────────────────┐
 |  JetstreamModule         |    │   NATS Server + JetStream    │
 |  ├─ forRoot()            │◄──►│   ┌─ streams                │
 |  ├─ forFeature()         │    │   ├─ consumers              │
 |  └─ JetstreamStrategy    │    │   └─ subjects               │
 +--------------------------+    └──────────────────────────────┘
                                                 │
 +--------------------------+                    │
 |  Microservice Controllers|◄───────────────────┘
 |  @EventPattern()         |    Messages pulled & routed
 |  @MessagePattern()       |    to handlers automatically
 +--------------------------+
```

The library sits between your NestJS application code and the NATS server. It provisions streams and consumers on startup, routes messages to decorated handlers, manages the connection lifecycle, and drains cleanly on shutdown. You interact with the standard NestJS abstractions (`ClientProxy`, `@Payload()`, `@Ctx()`) and the library translates them into JetStream operations.

## Where to start

Pick an entry point based on where you are in your journey:

- **New to the library?** — [Installation](/docs/getting-started/installation) → [Quick Start](/docs/getting-started/quick-start)
- **Comparing transports?** — [Why JetStream?](/docs/getting-started/why-jetstream) covers when Core NATS is enough and when you outgrow it
- **Migrating from `@nestjs/microservices` NATS?** — [Migration Guide](/docs/guides/migration)
- **Planning a production rollout?** — [Module Configuration](/docs/getting-started/module-configuration), [Dead Letter Queue](/docs/guides/dead-letter-queue), [Graceful Shutdown](/docs/guides/graceful-shutdown), [Health Checks](/docs/guides/health-checks), [Performance Tuning](/docs/guides/performance)
- **Looking for a specific delivery pattern?** — [Workqueue Events](/docs/patterns/events), [RPC (Request/Reply)](/docs/patterns/rpc), [Broadcast](/docs/patterns/broadcast), [Ordered Events](/docs/patterns/ordered-events)

The full feature catalog lives in the sidebar on the left — every page is one click away.

:::tip Runnable examples
The GitHub repository ships [7 self-contained demos](https://github.com/HorizonRepublic/nestjs-jetstream/tree/main/examples) covering events, RPC, scheduling, DLQ, health checks, and more. Clone and run.
:::
