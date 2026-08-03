---
sidebar_position: 1
title: Naming Conventions
schema:
  type: Article
  headline: Naming Conventions
  description: "Stream, consumer, and subject naming patterns derived from the service name."
  datePublished: "2026-03-21"
  dateModified: "2026-08-03"
---

# Naming Conventions

> **Use when:** you need to predict a stream, consumer or subject name from the outside.
> **You get:** the derivation rules from the single `name` value, and the helpers that compute them.

Every NATS subject, stream and consumer name is derived from the single `name` value you pass to `forRoot()`, through helper functions the package exports.

## The `__microservice` Suffix

Every service name is suffixed with `__microservice` to create an **internal name**. The suffix isolates the namespace, so your application subjects never collide with other NATS clients sharing the same cluster that might use bare service names.

```typescript
JetstreamModule.forRoot({
  name: 'orders', // internal name becomes: orders__microservice
  servers: ['nats://localhost:4222'],
});
```

## Full Naming Table

Everything below is written against `{internal}`, the internal name: `orders` becomes `orders__microservice`.

| Kind                                                      | Subject                        | Stream                      | Consumer                        |
| --------------------------------------------------------- | ------------------------------ | --------------------------- | ------------------------------- |
| Event                                                     | `{internal}.ev.{pattern}`      | `{internal}_ev-stream`      | `{internal}_ev-consumer`        |
| Command                                                   | `{internal}.cmd.{pattern}`     | `{internal}_cmd-stream`     | `{internal}_cmd-consumer`       |
| Ordered                                                   | `{internal}.ordered.{pattern}` | `{internal}_ordered-stream` | Ephemeral, no durable name      |
| Broadcast                                                 | `broadcast.{pattern}`          | `broadcast-stream`, shared  | `{internal}_broadcast-consumer` |
| [DLQ](/docs/guides/dead-letter-queue#built-in-dlq-stream) | `{internal}_dlq-stream`        | `{internal}_dlq-stream`     | Yours to create                 |

So a service named `orders` handling `order.created` consumes `orders__microservice.ev.order.created` from `orders__microservice_ev-stream` through `orders__microservice_ev-consumer`.

Ordered consumers are created and managed by the `@nats-io/jetstream` client at consumption time, so they never appear under a name you can look up. The DLQ stream publishes to a subject equal to its own name, and the transport creates no consumer on it: reading dead letters is your call, and the [DLQ guide](/docs/guides/dead-letter-queue#built-in-dlq-stream) covers how.

:::note Overriding the convention
`subjectPrefix`, `stream.name` and `consumer.durable_name` each override the derived value for one kind. That is how a service binds to infrastructure someone else provisioned; see [external infrastructure](/docs/guides/external-infrastructure).
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

Builds the JetStream stream name for one service and stream kind.

```typescript
import { streamName, StreamKind } from '@horizon-republic/nestjs-jetstream';

streamName('orders', StreamKind.Event);     // 'orders__microservice_ev-stream'
streamName('orders', StreamKind.Command);   // 'orders__microservice_cmd-stream'
streamName('orders', StreamKind.Ordered);   // 'orders__microservice_ordered-stream'
streamName('orders', StreamKind.Broadcast); // 'broadcast-stream'
```

### `consumerName(serviceName, kind)`

Builds the JetStream consumer name for one service and stream kind.

```typescript
import { consumerName, StreamKind } from '@horizon-republic/nestjs-jetstream';

consumerName('orders', StreamKind.Event);     // 'orders__microservice_ev-consumer'
consumerName('orders', StreamKind.Command);   // 'orders__microservice_cmd-consumer'
consumerName('orders', StreamKind.Broadcast); // 'orders__microservice_broadcast-consumer'
```

### `dlqStreamName(serviceName)`

Builds the [Dead Letter Queue stream](/docs/guides/dead-letter-queue#built-in-dlq-stream) name for one service. Use it to subscribe to the DLQ stream from an external consumer without hardcoding the naming pattern.

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

Each stream subscribes to a wildcard subject that captures every message of its kind. With [message scheduling](/docs/guides/scheduling) enabled (`allow_msg_schedules: true`), event and broadcast streams take a second filter for the scheduled twins:

| Kind      | Subject filter         | With scheduling enabled |
| --------- | ---------------------- | ----------------------- |
| Event     | `{internal}.ev.>`      | `{internal}._sch.>`     |
| Command   | `{internal}.cmd.>`     | -                       |
| Ordered   | `{internal}.ordered.>` | -                       |
| Broadcast | `broadcast.>`          | `broadcast._sch.>`      |

The `>` wildcard matches one or more tokens, so `orders__microservice.ev.>` captures `orders__microservice.ev.order.created`, `orders__microservice.ev.payment.processed` and everything else under that prefix.

`_sch` is this library's convention for keeping a scheduled message out of the filter its own consumer watches, until the server publishes it for real. NATS scheduling itself runs on headers (`Nats-Schedule`, `Nats-Schedule-Target` per [ADR-51](https://github.com/nats-io/nats-architecture-and-design/blob/main/adr/ADR-51.md)), not on subjects. You never address a `_sch` subject yourself.

## Names and multiple connections

Adding [named connections](/docs/guides/multi-connection) changes nothing here. Every name is derived from the service `name` alone, so two connections of one service resolve **identical** stream, consumer and subject names. Renaming them per connection would orphan existing streams and strand their messages, so the transport does not do it.

That makes one configuration mistake dangerous: two connections that reach the same cluster would provision the same stream and silently overwrite each other's configuration. Two checks prevent it.

**Config level, before any network call.** Two connections declaring an identical server set — normalized for ordering and the default `4222` port — fail at startup.

**NATS level.** Every provisioned stream carries a `nestjs-jetstream-owner` metadata entry of `{service}:{connection}`. This covers every stream whose name is derived from the service, the dead-letter stream included. A stream already stamped by a different connection of the same service fails provisioning, with both connection names in the error. A stamp belonging to a different service is left alone.

The shared `broadcast-stream` is exempt: every service in the cluster shares it, so a per-connection stamp would flip-flop on each deploy. Under `provisioning: { management: Manual }` nothing is stamped and the second check does not apply, since those streams are not ours to write to.

Metadata the transport did not author is preserved. An update carries forward whatever keys the stream already had, and a `metadata` block in your stream overrides is merged with the stamp rather than replaced by it.
