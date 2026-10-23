---
sidebar_position: 5
sidebar_label: "Handler Metadata"
title: "Handler Metadata Registry: NATS KV Service Discovery for NestJS"
description: "Publish NestJS handler metadata to a NATS KV bucket, so other services can discover handlers at runtime without a separate registry."
schema:
  type: Article
  headline: "Handler Metadata Registry: NATS KV Service Discovery for NestJS"
  description: "Publish NestJS handler metadata to a NATS KV bucket for dynamic service discovery, API gateway routing, and automatic catalog generation."
  datePublished: "2026-04-02"
  dateModified: "2026-10-23"
---

# Handler Metadata Registry

> **Use when:** something outside the service needs to know which handlers exist.
> **You get:** a NATS KV bucket published at startup, its key format, and the metadata shape.

A Go HTTP gateway needs to know which NestJS handlers exist and how to route to them. Hand-written routing tables drift out of sync on every deploy. Instead, attach `meta` to a handler: the transport writes it to a shared NATS KV bucket at startup, and the gateway (or a dashboard, or a CLI tool) watches the bucket and rebuilds its routing as services deploy.

## Quick start

### 1. Attach metadata to handlers

```typescript
import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

@Controller()
export class OrdersController {
  // meta → written to KV as {"http":{"method":"POST","path":"/orders"}}
  @EventPattern('order.created', {
    meta: { http: { method: 'POST', path: '/orders' } },
  })
  handleOrderCreated(@Payload() data: OrderCreatedDto): void {
    // ...
  }

  @MessagePattern('order.get', {
    meta: { http: { method: 'GET', path: '/orders/:id' }, auth: 'bearer' },
  })
  handleGetOrder(@Payload() data: GetOrderDto): Order {
    // ...
  }

  // No meta → not written to KV
  @EventPattern('internal.cleanup')
  handleCleanup(): void {
    // ...
  }
}
```

### 2. Start the app (no extra config needed)

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
})
```

The transport writes an entry per handler with `meta` to the `handler_registry` KV bucket. A failure to write is logged and does not stop the transport from starting.

### 3. Watch from an external service

```go
// Go gateway example
js, _ := jetstream.New(nc)
kv, _ := js.KeyValue(ctx, "handler_registry")
watcher, _ := kv.WatchAll(ctx)

for entry := range watcher.Updates() {
    if entry == nil {
        continue // initial values loaded
    }
    // entry.Key()   = "orders.ev.order.created"
    // entry.Value() = {"http":{"method":"POST","path":"/orders"}}
    updateRoutingTable(entry)
}
```

## Configuration

The registry turns on when any handler has `meta`, and every field is optional. Defaults and limits are in [Module Configuration](/docs/reference/module-configuration#metadata).

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  metadata: {
    bucket: 'handler_registry',
    replicas: 3,
    ttl: 30_000, // milliseconds, not nanoseconds
  },
})
```

:::note Bucket configuration
The KV bucket is created on first startup. Changing `ttl` or `replicas` after creation means deleting the existing bucket, because NATS KV does not update bucket config in place. Use the NATS CLI: `nats kv rm handler_registry`.
:::

## KV key format

Keys follow the pattern `{service_name}.{kind}.{pattern}`:

| Handler                                                       | Key                               |
| ------------------------------------------------------------- | --------------------------------- |
| `@EventPattern('order.created', { meta })`                    | `orders.ev.order.created`         |
| `@MessagePattern('order.get', { meta })`                      | `orders.cmd.order.get`            |
| `@EventPattern('config.updated', { broadcast: true, meta })`  | `orders.broadcast.config.updated` |
| `@EventPattern('audit.trail', { ordered: true, meta })`       | `orders.ordered.audit.trail`      |
| `@EventPattern('report.daily', { schedule: { cron }, meta })` | `orders.sched.report.daily`       |

The `metadataKey()` helper is exported for programmatic key construction:

```typescript
import { metadataKey, StreamKind } from '@horizon-republic/nestjs-jetstream';

const key = metadataKey('orders', StreamKind.Event, 'order.created');
// → "orders.ev.order.created"
```

## Meta structure

`meta` is a `Record<string, unknown>`, stored as JSON with no schema. Values must be JSON-serializable, and the structure is yours.

:::warning Security
The `meta` object is stored in a shared NATS KV bucket readable by any connected service. Never include secrets, API keys, passwords, or personally identifiable information (PII) in handler metadata.
:::

```typescript
// HTTP routing
{ meta: { http: { method: 'POST', path: '/orders' } } }

// Auth requirements
{ meta: { http: { method: 'GET', path: '/orders/:id' }, auth: 'bearer' } }

// Feature flags
{ meta: { feature: 'orders-v2', canary: true } }

// Documentation hints
{ meta: { description: 'Creates a new order', tags: ['orders'] } }
```

## Lifecycle

Entries live on TTL plus a heartbeat, so nothing deletes them explicitly.

- **Startup.** The transport writes all handler meta entries to KV and starts the heartbeat.
- **Heartbeat.** Every `ttl / 2`, all entries are re-written to reset their TTL.
- **Graceful shutdown.** The heartbeat stops, and entries expire after their TTL.
- **Crash.** The heartbeat stops, and entries expire after their TTL, which cleans up on its own.
- **Rolling update.** The new pod writes entries immediately, and old entries from removed handlers expire via TTL.
- **Multi-pod.** All pods heartbeat the same keys: entries stay alive while any pod is running.

## Use cases

- **API Gateway**: Watch the bucket, build HTTP routing table from `http.method` + `http.path`.
- **Service catalog**: Read all keys → display registered handlers with metadata.
- **Dynamic routing**: Feature flags, canary routing, A/B testing via handler metadata.
- **Auto-documentation**: Generate API docs from handler metadata.

## Debugging

Verify entries with the NATS CLI:

```bash
# List all keys in the bucket
nats kv ls handler_registry

# Read a specific entry
nats kv get handler_registry orders.ev.order.created

# Watch for real-time updates
nats kv watch handler_registry
```

If entries are missing or the bucket fails to create, see [Troubleshooting, Handler metadata registry](/docs/guides/troubleshooting#handler-metadata-registry).

## See also

- [Naming Conventions: `metadataKey()`](/docs/reference/naming-conventions#metadatakeyservicename-kind-pattern): programmatic key construction
- [Module Configuration](/docs/reference/module-configuration): the `metadata` option in the full options reference
- [Events (Workqueue)](/docs/patterns/events), [RPC](/docs/patterns/rpc), [Broadcast](/docs/patterns/broadcast), [Ordered Events](/docs/patterns/ordered-events): any handler type can attach `meta`
