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

NestJS' [built-in NATS transport](https://docs.nestjs.com/microservices/nats) loses messages on pod restart, doesn't retry on failure, and gives you nothing to debug with. [JetStream](https://docs.nats.io/nats-concepts/jetstream) fixes all three — but wiring it into NestJS by hand is a project on its own.

**`nestjs-jetstream` is the swap.** Same `@EventPattern`, same `@MessagePattern`, same `client.emit()`. Durability, retries, dead letters, and W3C tracing — underneath, automatic.

For a side-by-side with the built-in transport and the scenarios that force the switch, read [**Why JetStream?**](/docs/getting-started/why-jetstream).

## Where to start

Pick an entry point based on where you are in your journey:

- **New to the library?** — [Installation](/docs/getting-started/installation) → [Quick Start](/docs/getting-started/quick-start)
- **Comparing transports?** — [Why JetStream?](/docs/getting-started/why-jetstream) covers when Core NATS is enough and when you outgrow it
- **Migrating from `@nestjs/microservices` NATS?** — [Migration Guide](/docs/guides/migration)
- **Planning a production rollout?** — [Module Configuration](/docs/getting-started/module-configuration), [Dead Letter Queue](/docs/guides/dead-letter-queue), [Graceful Shutdown](/docs/guides/graceful-shutdown), [Health Checks](/docs/guides/health-checks), [Performance Tuning](/docs/guides/performance)
- **Looking for a specific delivery pattern?** — [Workqueue Events](/docs/patterns/events), [RPC (Request/Reply)](/docs/patterns/rpc), [Broadcast](/docs/patterns/broadcast), [Ordered Events](/docs/patterns/ordered-events)

The full feature catalog lives in the sidebar on the left — every page is one click away.

:::tip Runnable examples
The GitHub repository ships [9 self-contained demos](https://github.com/HorizonRepublic/nestjs-jetstream/tree/main/examples) covering events, RPC, ordered delivery, DLQ, health checks, scheduling, publisher-only mode, per-message TTL, and the handler metadata registry. Clone and run.
:::
