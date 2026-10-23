---
sidebar_position: 1
title: Naming Conventions
schema:
  type: Article
  headline: Naming Conventions
  description: "Stream, consumer, and subject naming patterns derived from the service name."
  datePublished: "2026-03-21"
  dateModified: "2026-10-23"
---

# Naming Conventions

> **Use when:** you need to predict a stream, consumer or subject name from the outside.
> **You get:** the derivation rules from the single `name` value, and the helpers that compute them.

## The `__microservice` Suffix

Every service name gets the `__microservice` suffix to form its **internal name**. The suffix keeps your subjects apart from other NATS clients on the cluster that use bare service names.

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
| [Schedule](/docs/guides/recurring-schedules)              | `{internal}.sched.{pattern}`   | `{internal}_sched-stream`   | `{internal}_sched-consumer`     |
| [DLQ](/docs/guides/dead-letter-queue#built-in-dlq-stream) | `{internal}_dlq-stream`        | `{internal}_dlq-stream`     | Yours to create                 |

A service called `orders` handling `order.created` ends up consuming `orders__microservice.ev.order.created` from `orders__microservice_ev-stream` through `orders__microservice_ev-consumer`.

- Ordered consumers are created by the `@nats-io/jetstream` client at consumption time, so they have no name you can look up.
- The schedule stream exists only when a handler declares `schedule` in its `@EventPattern` extras. Its subjects carry the ticks; the schedule definitions (holders) live under `{internal}._cron.`, see [below](#stream-subject-wildcards).
- The DLQ stream's subject equals its own name, and the transport creates no consumer on it. The [DLQ guide](/docs/guides/dead-letter-queue#built-in-dlq-stream) covers reading dead letters.

:::note Overriding the convention
`subjectPrefix`, `stream.name` and `consumer.durable_name` each override the derived value for one kind. That is how a service binds to infrastructure someone else provisioned. See [external infrastructure](/docs/guides/external-infrastructure).
:::

## Helper Functions

All of these are exported from `@horizon-republic/nestjs-jetstream`.

### `internalName(name)`

```typescript
import { internalName } from '@horizon-republic/nestjs-jetstream';

internalName('orders'); // 'orders__microservice'
```

### `buildSubject(serviceName, kind, pattern)`

Builds a fully qualified subject for every kind except broadcast.

```typescript
import { buildSubject, StreamKind } from '@horizon-republic/nestjs-jetstream';

buildSubject('orders', StreamKind.Event, 'order.created');
// 'orders__microservice.ev.order.created'

buildSubject('orders', StreamKind.Command, 'get-order');
// 'orders__microservice.cmd.get-order'

buildSubject('orders', StreamKind.Ordered, 'order.updated');
// 'orders__microservice.ordered.order.updated'

buildSubject('orders', StreamKind.Schedule, 'report.daily');
// 'orders__microservice.sched.report.daily'
```

### `buildBroadcastSubject(pattern)`

Broadcast subjects are not scoped to a service.

```typescript
import { buildBroadcastSubject } from '@horizon-republic/nestjs-jetstream';

buildBroadcastSubject('config.updated');
// 'broadcast.config.updated'
```

### `streamName(serviceName, kind)`

```typescript
import { streamName, StreamKind } from '@horizon-republic/nestjs-jetstream';

streamName('orders', StreamKind.Event);     // 'orders__microservice_ev-stream'
streamName('orders', StreamKind.Command);   // 'orders__microservice_cmd-stream'
streamName('orders', StreamKind.Ordered);   // 'orders__microservice_ordered-stream'
streamName('orders', StreamKind.Schedule);  // 'orders__microservice_sched-stream'
streamName('orders', StreamKind.Broadcast); // 'broadcast-stream'
```

### `consumerName(serviceName, kind)`

```typescript
import { consumerName, StreamKind } from '@horizon-republic/nestjs-jetstream';

consumerName('orders', StreamKind.Event);     // 'orders__microservice_ev-consumer'
consumerName('orders', StreamKind.Command);   // 'orders__microservice_cmd-consumer'
consumerName('orders', StreamKind.Schedule);  // 'orders__microservice_sched-consumer'
consumerName('orders', StreamKind.Broadcast); // 'orders__microservice_broadcast-consumer'
```

### `dlqStreamName(serviceName)`

Name of the [DLQ stream](/docs/guides/dead-letter-queue#built-in-dlq-stream), for an external consumer that reads it without hardcoding the pattern.

```typescript
import { dlqStreamName } from '@horizon-republic/nestjs-jetstream';

dlqStreamName('orders'); // 'orders__microservice_dlq-stream'
```

### `metadataKey(serviceName, kind, pattern)`

KV key of one handler in the [handler metadata registry](/docs/patterns/handler-metadata) bucket.

```typescript
import { metadataKey, StreamKind } from '@horizon-republic/nestjs-jetstream';

metadataKey('orders', StreamKind.Event, 'order.created');
// 'orders.ev.order.created'
```

## Stream Subject Wildcards

Each stream captures its kind with one wildcard. A stream that holds schedule definitions (holders) gets a second subject for them, unless the kind has a custom `subjectPrefix`, in which case `{prefix}>` already covers `{prefix}_sch.` or `{prefix}_cron.`.

| Kind      | Stream subjects        | Holder subjects                                                                  |
| --------- | ---------------------- | -------------------------------------------------------------------------------- |
| Event     | `{internal}.ev.>`      | `{internal}._sch.>`, added with [`allow_msg_schedules`](/docs/guides/scheduling) |
| Command   | `{internal}.cmd.>`     | none                                                                             |
| Ordered   | `{internal}.ordered.>` | none                                                                             |
| Broadcast | `broadcast.>`          | `broadcast._sch.`, already inside `broadcast.>`                                  |
| Schedule  | `{internal}.sched.>`   | `{internal}._cron.>`, always                                                     |

- `_sch.` holds one-shot `scheduleAt()` messages until the server publishes them to the real subject. The prefix keeps them out of the filter their own consumer watches.
- `_cron.` holds [recurring schedules](/docs/guides/recurring-schedules): `_cron.decl.{pattern}` for schedules declared on handlers, `_cron.dyn.{id}` for those created with `client.schedule()`. Each fires ticks to `{internal}.sched.{pattern}`.

NATS scheduling itself runs on headers (`Nats-Schedule`, `Nats-Schedule-Target`, [ADR-51](https://github.com/nats-io/nats-architecture-and-design/blob/main/adr/ADR-51.md)), not on subjects. You never address a holder subject yourself.

## Names and multiple connections

Adding [connections](/docs/guides/multi-connection) changes nothing here. Every name is derived from the service `name` alone, so two connections of one service resolve **identical** stream, consumer and subject names. Renaming them per connection would orphan existing streams and strand their messages, so the transport does not do it.

Two connections that reach the same cluster would therefore provision the same stream and overwrite each other's configuration. The transport catches this twice.

**Config level, before any network call.** Connections that declare an identical server set, normalized for ordering and the default `4222` port, fail at startup.

**NATS level.** Every stream whose name derives from the service, the dead-letter stream included, carries a `nestjs-jetstream-owner` metadata entry of `{service}:{connection}`. A stream already stamped by a different connection of the same service fails provisioning, with both connection names in the error. A stamp belonging to a different service is left alone.

The shared `broadcast-stream` is exempt: every service in the cluster shares it, so a per-connection stamp would flip-flop on each deploy. Under `provisioning: { management: Manual }` nothing is stamped and the second check does not apply, since those streams are not ours to write to.

Metadata the transport did not author is preserved. An update carries forward whatever keys the stream already had, and a `metadata` block in your stream overrides is merged with the stamp instead of replacing it.
