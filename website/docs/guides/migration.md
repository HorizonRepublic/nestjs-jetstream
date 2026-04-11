---
sidebar_position: 5
title: "Migration Guide"
schema:
  type: Article
  headline: "Migration Guide"
  description: "Migrate from the built-in NestJS NATS transport to JetStream with durable delivery."
  datePublished: "2026-03-26"
  dateModified: "2026-04-11"
---

# Migration Guide

## From `@nestjs/microservices` NATS transport

If your `ClientProxy` already talks to NATS, switching to JetStream is mostly configuration. Here are the five steps.

### What changes

| Aspect | Built-in NATS | nestjs-jetstream |
|--------|---------------|-----------------|
| **Delivery** | At-most-once (fire-and-forget) | At-least-once (persistent) |
| **Retention** | None — messages lost if no subscriber | Stream-based — messages survive restarts |
| **Replay** | Not supported | New consumers catch up on history |
| **Fan-out** | All subscribers get every message | Workqueue (one handler) or Broadcast (all) |
| **RPC** | Core request/reply | Core (default) or JetStream-backed |
| **DLQ** | Not supported | Dedicated DLQ stream with tracking headers, or `onDeadLetter` callback |
| **Ack/Nak** | Not applicable | Explicit acknowledgment per message |

### Step 1 — Install the library

```bash
pnpm add @horizon-republic/nestjs-jetstream
```

The `@nats-io/*` client packages come in as direct dependencies — you don't have to install them yourself. Only your NestJS peer dependencies matter: make sure your project meets the [runtime requirements](/docs/getting-started/installation#runtime-requirements) (Node.js, NestJS, TypeScript versions).

### Step 2 — Replace module registration

**Before (built-in):**
```typescript
// main.ts
app.connectMicroservice({
  transport: Transport.NATS,
  options: { servers: ['nats://localhost:4222'] },
});
```

**After (nestjs-jetstream):**
```typescript
// app.module.ts
@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'my-service',
      servers: ['nats://localhost:4222'],
    }),
  ],
})
export class AppModule {}
```

Then connect the transport in your bootstrap file, just like in the [Quick Start](/docs/getting-started/quick-start#2-connect-the-transport):

```typescript
const app = await NestFactory.create(AppModule);
app.connectMicroservice({ strategy: app.get(JetstreamStrategy) }, { inheritAppConfig: true });
await app.startAllMicroservices();
```

### Step 3 — Keep your handlers

Your existing `@EventPattern()` and `@MessagePattern()` handlers work as-is. The decorators are the same — only the underlying transport changes.

```typescript
// Works with both transports — no code changes needed
@EventPattern('user.created')
async handleUserCreated(@Payload() data: UserDto) {
  await this.userService.process(data);
}

@MessagePattern('user.get')
async getUser(@Payload() id: string) {
  return this.userService.findById(id);
}
```

### Step 4 — Replace client injection

**Before (built-in):**
```typescript
@Inject('NATS_SERVICE') private readonly client: ClientProxy
```

**After (nestjs-jetstream):**
```typescript
// Register in the module
JetstreamModule.forFeature({ name: 'users' })

// Inject with the service name as the token
@Inject('users') private readonly client: ClientProxy
```

### Step 5 — Adjust for acknowledgment semantics

The key behavioral difference: messages are now **acknowledged explicitly**. If your handler throws, the message is retried (up to `max_deliver` times, default 3).

**Idempotency matters now.** If a handler is called twice with the same message, the second call should produce the same result. Use message deduplication or idempotent operations.

### What you gain

After migration, you get for free:
- Messages survive NATS server restarts
- Failed messages are automatically retried
- Dead letter handling for exhausted retries
- Health checks with RTT monitoring
- Graceful shutdown with message drain
- Broadcast fan-out to all service instances
- Ordered sequential delivery mode

## Upgrading between versions

### v2.8 → v2.9

**Notable change:**

:::caution Broadcast `max_age` reduced: 1 day → 1 hour
Broadcast messages (config propagation, cache invalidation, feature flags) are relevant for minutes, not days. The new default provides a sufficient catch-up window while reducing storage. This is a mutable property — **existing streams update automatically on next application startup**. If you need a longer retention window, override it explicitly:
```typescript
broadcast: { stream: { max_age: toNanos(1, 'days') } }
```
:::

**New features:**
- [**Built-in Dead Letter Queue stream**](/docs/guides/dead-letter-queue#built-in-dlq-stream) — add the `dlq: { stream }` option to `forRoot()` and the library provisions a dedicated DLQ stream on startup. Exhausted messages are automatically republished with tracking headers (`x-dead-letter-reason`, `x-original-subject`, `x-original-stream`, `x-failed-at`, `x-delivery-count`). The `onDeadLetter` callback remains available as a standalone option or as a notification/safety-net hook when combined with the DLQ stream.
- [**Per-message TTL**](/docs/guides/per-message-ttl) — `JetstreamRecordBuilder.ttl(duration)` sets the `Nats-TTL` header (NATS 2.11+), allowing individual messages to expire independently of the stream's `max_age`. Requires `allow_msg_ttl: true` on the target stream.
- [**Handler metadata registry (NATS KV)**](/docs/patterns/handler-metadata) — when enabled via the `metadata` option, the library publishes all registered `@EventPattern` / `@MessagePattern` handlers to a NATS KV bucket at startup, enabling cross-service discovery without a separate service registry.
- [**Stream migration**](/docs/guides/stream-migration) — automatic blue-green stream recreation for immutable property changes (`storage`, `retention`, etc.). Enable with `allowDestructiveMigration: true` on a per-stream basis.
- **Consumer self-healing auto-recreation** — consumers deleted externally (via NATS CLI, cluster issues) are automatically recreated on the next poll. Migration-aware: waits during active stream migrations.
- **`StreamConfigOverrides` type** — prevents users from overriding `retention` (transport-controlled).
- **`NatsErrorCode` enum** for NATS JetStream API error codes, so error handling code can switch on typed constants instead of magic strings.

No breaking changes.

### v2.7 → v2.8

**Breaking change:** migrated from `nats` package to `@nats-io/*` scoped packages (v3.x).

This is an internal change — the library re-exports everything users need. If you import types directly from `nats` in your own code, update them:

```diff
- import { JsMsg, NatsConnection } from 'nats';
+ import { JsMsg } from '@nats-io/jetstream';
+ import { NatsConnection } from '@nats-io/transport-node';
```

**New features:**
- [Message scheduling](/docs/guides/scheduling) — one-shot delayed delivery via `scheduleAt()` (requires NATS >= 2.12)
- `allow_msg_schedules` stream config option

### v2.6 → v2.7

v2.7 shipped handler-controlled settlement — a way to ack, nak, or terminate a message without throwing.

**New features:**
- Handler-controlled settlement via [`ctx.retry()` and `ctx.terminate()`](/docs/guides/handler-context#controlling-message-settlement) — control message acknowledgment without throwing errors
- Metadata getters on [`RpcContext`](/docs/guides/handler-context#jetstream-message-info): `getDeliveryCount()`, `getStream()`, `getSequence()`, `getTimestamp()`, `getCallerName()`

No breaking changes.

### v2.5 → v2.6

v2.6 was the performance release — concurrency control, ack extension, and production-ready defaults for reconnection and compression.

**New features:**
- Configurable [concurrency](/docs/guides/performance#concurrency-control) for event/broadcast/RPC processing
- [Ack extension](/docs/guides/performance#ack-extension) (`ackExtension: true`) for long-running handlers
- Consume options passthrough for advanced prefetch tuning
- Heartbeat monitoring with automatic consumer restart
- S2 stream compression enabled by default (see [Stream Defaults](/docs/reference/default-configs#stream-defaults))
- Performance connection defaults (unlimited reconnect, 1s interval)

No breaking changes.

### v2.4 → v2.5

**Breaking change:** `nanos()` renamed to `toNanos()`.

```diff
- import { nanos } from '@horizon-republic/nestjs-jetstream';
+ import { toNanos } from '@horizon-republic/nestjs-jetstream';

  consumer: {
-   ack_wait: nanos(30, 'seconds'),
+   ack_wait: toNanos(30, 'seconds'),
  }
```

### v2.3 → v2.4

**New features:**
- Ordered events (`ordered:` prefix, `DeliverPolicy` options)
- Custom message IDs via `setMessageId()` for publish-side deduplication
- Documentation site (Docusaurus)

No breaking changes.

### v2.1 → v2.2

**New features:**
- Dead letter queue support via `onDeadLetter` callback
- `DeadLetterInfo` interface with full message context

No breaking changes.

## See also

- [Installation](/docs/getting-started/installation) — setup requirements
- [Module Configuration](/docs/getting-started/module-configuration) — full options reference
- [Quick Start](/docs/getting-started/quick-start) — first handler in 5 minutes
