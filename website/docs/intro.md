---
slug: /
sidebar_position: 1
title: Introduction
schema:
  type: Article
  headline: "Introduction"
  description: "Production-grade NestJS transport for NATS JetStream with durable delivery, retry, replay, and dead letter handling."
  datePublished: "2026-03-21"
  dateModified: "2026-04-01"
---

# Introduction

**@horizon-republic/nestjs-jetstream** is a production-grade NestJS transport for [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream). It brings persistent, at-least-once messaging to NestJS microservices while staying true to the framework's `@EventPattern` / `@MessagePattern` programming model.

## Why this library?

NestJS ships with a [built-in NATS transport](https://docs.nestjs.com/microservices/nats), but it operates exclusively over NATS Core — a fire-and-forget, in-memory pub/sub layer. That's fine for ephemeral messages, but when you need:

- **Persistent delivery** — messages survive broker and consumer restarts
- **At-least-once semantics** — automatic redelivery on failure with configurable retry limits
- **Stream-based replay** — new consumers can catch up on historical messages
- **Fan-out broadcast** — every running instance of a service receives every message

...you need JetStream. This library manages streams, consumers, and subjects automatically so you can focus on business logic instead of NATS plumbing.

## Feature overview

| Capability | What it does |
|---|---|
| **Workqueue Events** | At-least-once delivery, one handler instance processes each message |
| **Broadcast Events** | Fan-out to all subscribing services via per-service durable consumers |
| **Ordered Events** | Strict sequential delivery with automatic failover (Limits retention) |
| **RPC — Core mode** | NATS native request/reply for lowest latency |
| **RPC — JetStream mode** | Commands persisted in a stream, responses via Core NATS inbox |
| **Dead Letter Queue** | Callback when a message exhausts all delivery attempts |
| **Lifecycle Hooks** | Observable events: connect, disconnect, errors, timeouts, shutdown |
| **Health Checks** | `JetstreamHealthIndicator` for readiness/liveness probes |
| **Custom Codec** | Pluggable serialization — JSON (default), MessagePack, Protobuf, etc. |
| **Graceful Shutdown** | Drain in-flight messages before closing the connection |
| **Message Scheduling** | One-shot delayed delivery via NATS 2.12 `Nats-Schedule` headers |
| **Publisher-only mode** | `consumer: false` for API gateways that only emit messages |

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

The library sits between your NestJS application code and the NATS server. It:

1. **Manages infrastructure** — creates and updates JetStream streams and consumers on startup
2. **Routes messages** — maps NATS subjects to your `@EventPattern` and `@MessagePattern` handlers
3. **Handles lifecycle** — connection management, graceful shutdown, error propagation

You interact with standard NestJS abstractions (`ClientProxy`, `@Payload()`, `@Ctx()`) and the library translates them into JetStream operations.

## What you'll learn

This documentation is organized into sections that progressively build on each other:

- [**Getting Started**](/docs/getting-started/installation) — install, configure, and run your first handler in minutes
- [**Messaging Patterns**](/docs/patterns/rpc) — deep dive into RPC, Events, Broadcast, and Ordered Events
- [**Guides**](/docs/guides/record-builder) — Record Builder, Scheduling, Custom Codec, Handler Context, DLQ, Health Checks, Lifecycle Hooks, Graceful Shutdown, Performance Tuning, Troubleshooting
- [**Migration**](/docs/guides/migration) — upgrading from the built-in NATS transport or between library versions
- [**Reference**](/docs/reference/naming-conventions) — naming conventions, default configs, edge cases, and full API reference

:::tip Ready to start?
Head to [Installation](/docs/getting-started/installation) to add the library to your project, or jump straight to the [Quick Start](/docs/getting-started/quick-start) if you already have NATS running.
:::
