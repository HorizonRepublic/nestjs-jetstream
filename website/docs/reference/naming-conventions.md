---
sidebar_position: 1
title: Naming Conventions
schema:
  type: Article
  headline: Naming Conventions
  description: "Stream, consumer, and subject naming patterns derived from the service name."
  datePublished: "2026-03-21"
  dateModified: "2026-04-11"
---

# Naming Conventions

The transport derives all NATS subject names, stream names, and consumer names from the single `name` value you pass to `forRoot()`. This page documents every naming rule and the helper functions behind them.

## The `__microservice` Suffix

Every service name is suffixed with `__microservice` to create an **internal name**. This suffix provides namespace isolation — it ensures your application subjects never collide with other NATS clients sharing the same cluster that might use bare service names.

```typescript
JetstreamModule.forRoot({
  name: 'orders', // internal name becomes: orders__microservice
  servers: ['nats://localhost:4222'],
});
```

## Full Naming Table

Given `name: 'orders'`, the transport generates the following names:

### Subjects

| Type | Pattern | Example |
|------|---------|---------|
| Internal name | `{name}__microservice` | `orders__microservice` |
| Event subject | `{name}__microservice.ev.{pattern}` | `orders__microservice.ev.order.created` |
| RPC command subject | `{name}__microservice.cmd.{pattern}` | `orders__microservice.cmd.get-order` |
| Ordered subject | `{name}__microservice.ordered.{pattern}` | `orders__microservice.ordered.order.updated` |
| Broadcast subject | `broadcast.{pattern}` | `broadcast.config.updated` |

### Streams

| Stream Type | Name Pattern | Example |
|-------------|-------------|---------|
| Event stream | `{name}__microservice_ev-stream` | `orders__microservice_ev-stream` |
| Command stream | `{name}__microservice_cmd-stream` | `orders__microservice_cmd-stream` |
| Ordered stream | `{name}__microservice_ordered-stream` | `orders__microservice_ordered-stream` |
| Broadcast stream | `broadcast-stream` | `broadcast-stream` |
| [DLQ stream](/docs/guides/dead-letter-queue#built-in-dlq-stream) | `{name}__microservice_dlq-stream` | `orders__microservice_dlq-stream` |

### Consumers

| Consumer Type | Name Pattern | Example |
|---------------|-------------|---------|
| Event consumer | `{name}__microservice_ev-consumer` | `orders__microservice_ev-consumer` |
| Command consumer | `{name}__microservice_cmd-consumer` | `orders__microservice_cmd-consumer` |
| Broadcast consumer | `{name}__microservice_broadcast-consumer` | `orders__microservice_broadcast-consumer` |

:::note
Ordered consumers are **ephemeral** — they are created and managed by the `@nats-io/jetstream` client at consumption time and do not have a durable consumer name.
:::

:::info
The broadcast stream (`broadcast-stream`) is **shared** across all services. Each service creates its own durable consumer on this shared stream, named with the service-specific prefix (e.g., `orders__microservice_broadcast-consumer`).
:::

## Helper Functions

The transport exports the following helper functions from `@horizon-republic/nestjs-jetstream`:

### `internalName(name)`

Builds the internal service name with the `__microservice` suffix.

```typescript
import { internalName } from '@horizon-republic/nestjs-jetstream';

internalName('orders'); // 'orders__microservice'
```

### `buildSubject(serviceName, kind, pattern)`

Builds a fully-qualified NATS subject for workqueue events, RPC commands, or ordered events.

```typescript
import { buildSubject, StreamKind } from '@horizon-republic/nestjs-jetstream';

buildSubject('orders', StreamKind.Event, 'order.created');
// 'orders__microservice.ev.order.created'

buildSubject('orders', StreamKind.Command, 'get-order');
// 'orders__microservice.cmd.get-order'

buildSubject('orders', StreamKind.Ordered, 'order.updated');
// 'orders__microservice.ordered.order.updated'
```

### `buildBroadcastSubject(pattern)`

Builds a broadcast subject. Broadcast subjects are not scoped to a service name.

```typescript
import { buildBroadcastSubject } from '@horizon-republic/nestjs-jetstream';

buildBroadcastSubject('config.updated');
// 'broadcast.config.updated'
```

### `streamName(serviceName, kind)`

Builds the JetStream stream name for a given service and stream kind.

```typescript
import { streamName, StreamKind } from '@horizon-republic/nestjs-jetstream';

streamName('orders', StreamKind.Event);     // 'orders__microservice_ev-stream'
streamName('orders', StreamKind.Command);   // 'orders__microservice_cmd-stream'
streamName('orders', StreamKind.Ordered);   // 'orders__microservice_ordered-stream'
streamName('orders', StreamKind.Broadcast); // 'broadcast-stream'
```

### `consumerName(serviceName, kind)`

Builds the JetStream consumer name for a given service and stream kind.

```typescript
import { consumerName, StreamKind } from '@horizon-republic/nestjs-jetstream';

consumerName('orders', StreamKind.Event);     // 'orders__microservice_ev-consumer'
consumerName('orders', StreamKind.Command);   // 'orders__microservice_cmd-consumer'
consumerName('orders', StreamKind.Broadcast); // 'orders__microservice_broadcast-consumer'
```

### `dlqStreamName(serviceName)`

Builds the [Dead Letter Queue stream](/docs/guides/dead-letter-queue#built-in-dlq-stream) name for a given service. Use it to subscribe to the DLQ stream from an external consumer without hardcoding the naming pattern.

```typescript
import { dlqStreamName } from '@horizon-republic/nestjs-jetstream';

dlqStreamName('orders'); // 'orders__microservice_dlq-stream'
```

### `metadataKey(serviceName, kind, pattern)`

Builds the KV key used by the [handler metadata registry](/docs/patterns/handler-metadata). External watchers (gateways, dashboards, service catalogs) use this helper to look up specific handlers in the shared `handler_registry` bucket.

```typescript
import { metadataKey, StreamKind } from '@horizon-republic/nestjs-jetstream';

metadataKey('orders', StreamKind.Event, 'order.created');
// 'orders.ev.order.created'
```

## Stream Subject Wildcards

Each stream subscribes to a wildcard subject pattern that captures all messages for its type:

| Stream Kind | Subject Filter |
|------------|---------------|
| Event | `{name}__microservice.ev.>` |
| Command | `{name}__microservice.cmd.>` |
| Ordered | `{name}__microservice.ordered.>` |
| Broadcast | `broadcast.>` |

The `>` wildcard matches one or more tokens, so `orders__microservice.ev.>` will capture `orders__microservice.ev.order.created`, `orders__microservice.ev.payment.processed`, etc.

### Scheduling subjects

When [message scheduling](/docs/guides/scheduling) is enabled (`allow_msg_schedules: true`), the transport adds additional subject filters to capture scheduled messages:

| Stream Kind | Additional Subject Filter |
|------------|--------------------------|
| Event | `{name}__microservice._sch.>` |
| Broadcast | `broadcast._sch.>` |

The `_sch` subjects are a library convention to separate scheduled messages from regular events within the same stream. NATS scheduling itself works via headers (`Nats-Schedule`, `Nats-Schedule-Target` per [ADR-51](https://github.com/nats-io/nats-architecture-and-design/blob/main/adr/ADR-51.md)), not special subjects. You don't interact with `_sch` subjects directly — the library manages them automatically.
