---
slug: /
sidebar_position: 1
title: Introduction
schema:
  type: Article
  headline: "Introduction"
  description: "Production-grade NestJS transport for NATS JetStream with durable delivery, retry, replay, and dead letter handling."
  datePublished: "2026-03-21"
  dateModified: "2026-04-11"
---

# Introduction

**@horizon-republic/nestjs-jetstream** is a production-grade NestJS transport for [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream). It brings persistent, at-least-once messaging to NestJS microservices while staying true to the framework's `@EventPattern` / `@MessagePattern` programming model.

## Why this library?

NestJS ships with a [built-in NATS transport](https://docs.nestjs.com/microservices/nats) that operates over Core NATS — fire-and-forget, no persistence, no replay. The moment you need durable delivery, automatic retry, fan-out broadcast, or dead letter handling, you need JetStream. This library gives you all of it behind the same NestJS decorators you already use.

For a full comparison and decision guide, read [**Why JetStream?**](/docs/getting-started/why-jetstream).

## Architecture at a glance

```
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
