---
sidebar_position: 5
title: "Handler Metadata Registry"
schema:
  type: Article
  headline: "Handler Metadata Registry"
  description: "Publish handler metadata to a NATS KV bucket for dynamic service discovery, API gateway routing, and catalog generation."
  datePublished: "2026-04-02"
  dateModified: "2026-04-02"
---

import Since from '@site/src/components/Since';

# Handler Metadata Registry

<Since version="2.9.0" />

Publish handler metadata to a NATS KV bucket at startup. External services — API gateways, dashboards, CLI tools — can read or watch the bucket for automatic service discovery.

## The problem

A Go HTTP gateway needs to know which NestJS handlers exist and how to route requests. Without a metadata registry, this requires manual config files or hardcoded routing tables that fall out of sync on every deploy.

## The solution

Attach `meta` to handler extras → transport writes it to a shared NATS KV bucket → gateway watches the bucket and builds routing automatically. Zero config, auto-updates on deploy.

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

The transport detects handlers with `meta` and writes entries to the `handler_registry` KV bucket automatically.

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

All fields are optional. The registry auto-enables when any handler has `meta`.

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  metadata: {
    bucket: 'handler_registry',   // default: 'handler_registry'
    replicas: 3,                  // default: 1
    cleanupOnShutdown: true,      // default: true
  },
})
```

| Option | Default | Description |
|---|---|---|
| `bucket` | `'handler_registry'` | KV bucket name |
| `replicas` | `1` | Bucket replicas (1, 3, or 5) |
| `cleanupOnShutdown` | `true` | Delete entries on graceful shutdown |

## KV key format

Keys follow the pattern `{service_name}.{kind}.{pattern}`:

| Handler | Key |
|---|---|
| `@EventPattern('order.created', { meta })` | `orders.ev.order.created` |
| `@MessagePattern('order.get', { meta })` | `orders.cmd.order.get` |
| `@EventPattern('config.updated', { broadcast: true, meta })` | `orders.broadcast.config.updated` |
| `@EventPattern('audit.trail', { ordered: true, meta })` | `orders.ordered.audit.trail` |

The `metadataKey()` helper is exported for programmatic key construction:

```typescript
import { metadataKey, StreamKind } from '@horizon-republic/nestjs-jetstream';

const key = metadataKey('orders', StreamKind.Event, 'order.created');
// → "orders.ev.order.created"
```

## Meta structure

The `meta` field is `Record<string, unknown>` — the library stores it as-is with no schema enforcement. You decide the structure based on your use case:

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

| Event | Behavior |
|---|---|
| **Startup** | Transport writes all handler meta entries to KV |
| **Rolling update** | New pod writes same keys with (potentially updated) meta |
| **Graceful shutdown** | Entries deleted from KV (when `cleanupOnShutdown: true`) |
| **Crash** | Entries persist — next startup refreshes them |
| **Multi-pod** | All pods write same keys with same data (idempotent) |

## Use cases

- **API Gateway**: Watch the bucket, build HTTP routing table from `http.method` + `http.path`.
- **Service catalog**: Read all keys → display registered handlers with metadata.
- **Dynamic routing**: Feature flags, canary routing, A/B testing via handler metadata.
- **Auto-documentation**: Generate API docs from handler metadata.
