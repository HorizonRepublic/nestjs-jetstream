---
sidebar_position: 10
title: "Migration Guide"
schema:
  type: Article
  headline: "Migration Guide"
  description: "Migrate from the built-in NestJS NATS transport to JetStream with durable delivery."
  datePublished: "2026-03-26"
  dateModified: "2026-03-26"
---

# Migration Guide

## From `@nestjs/microservices` NATS transport

The built-in NestJS NATS transport uses Core NATS — fire-and-forget pub/sub with no persistence. This library adds JetStream on top, providing durable delivery, retry, and replay.

### What changes

| Aspect | Built-in NATS | nestjs-jetstream |
|--------|---------------|-----------------|
| **Delivery** | At-most-once (fire-and-forget) | At-least-once (persistent) |
| **Retention** | None — messages lost if no subscriber | Stream-based — messages survive restarts |
| **Replay** | Not supported | New consumers catch up on history |
| **Fan-out** | All subscribers get every message | Workqueue (one handler) or Broadcast (all) |
| **RPC** | Core request/reply | Core (default) or JetStream-backed |
| **DLQ** | Not supported | `onDeadLetter` callback after N failures |
| **Ack/Nak** | Not applicable | Explicit acknowledgment per message |

### Step 1 — Install the library

```bash
pnpm add @horizon-republic/nestjs-jetstream
```

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

The transport connects automatically — no `connectMicroservice()` call needed.

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

// Inject with the service name
@Inject(getClientToken('users')) private readonly client: JetstreamClient
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

### v2.7 → v2.8

**New features:**
- [Message scheduling](/docs/guides/scheduling) — one-shot delayed delivery via `scheduleAt()` (requires NATS >= 2.12)
- `allow_msg_schedules` stream config option

No breaking changes.

### v2.6 → v2.7

**Breaking change:** migrated from `nats` package to `@nats-io/*` scoped packages (v3.x).

This is an internal change — the library re-exports everything users need. If you import types directly from `nats` in your own code, update them:

```diff
- import { JsMsg, NatsConnection } from 'nats';
+ import { JsMsg } from '@nats-io/jetstream';
+ import { NatsConnection } from '@nats-io/transport-node';
```

### v2.5 → v2.6

**New features:**
- Dead letter queue support via `onDeadLetter` callback
- `DeadLetterInfo` interface with full message context

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

**New features:**
- Configurable concurrency for event/broadcast/RPC processing
- Ack extension (`ackExtension: true`) for long-running handlers
- Consume options passthrough for advanced prefetch tuning
- Heartbeat monitoring with automatic consumer restart
- S2 stream compression enabled by default
- Performance connection defaults (unlimited reconnect, 1s interval)

### v2.3 → v2.4

**New features:**
- Ordered events (`ordered:` prefix, `DeliverPolicy` options)
- Documentation site (Docusaurus)

No breaking changes.

## See also

- [Installation](/docs/getting-started/installation) — setup requirements
- [Module Configuration](/docs/getting-started/module-configuration) — full options reference
- [Quick Start](/docs/getting-started/quick-start) — first handler in 5 minutes
