---
sidebar_position: 2
sidebar_label: "Default Configs"
title: "Default Stream & Consumer Configs for NATS JetStream"
description: "Default stream, consumer, and connection settings for every NestJS JetStream StreamKind (event, broadcast, ordered, command, schedule, DLQ)."
schema:
  type: Article
  headline: "Default Stream & Consumer Configs for NATS JetStream"
  description: "Default stream, consumer, and connection settings for every NestJS JetStream StreamKind (event, broadcast, ordered, command, schedule, DLQ)."
  datePublished: "2026-03-21"
  dateModified: "2026-10-30"
---

# Default Configs

> **Use when:** you need the exact value the transport starts from before overriding it.
> **You get:** every stream, consumer and connection default, and the exported constant that holds it.

Override any of these through [module configuration](/docs/reference/module-configuration). Your values merge on top of the defaults, so name only what you change.

## Stream Defaults

Every stream is created with `storage: File`, `num_replicas: 1` (see [replicas in production](#replicas-in-production)), `allow_direct: true` and `compression: S2`. What differs per kind:

| Property                  | Event       | Command      | Broadcast   | Ordered     | Schedule    | DLQ         |
| ------------------------- | ----------- | ------------ | ----------- | ----------- | ----------- | ----------- |
| `retention`               | `Workqueue` | `Workqueue`  | `Limits`    | `Limits`    | `Workqueue` | `Limits`    |
| `discard`                 | `New`       | `New`        | `Old`       | `Old`       | `Old`       | `New`       |
| `discard_new_per_subject` | `true`      | `true`       | `false`     | `false`     | `false`     | `false`     |
| `allow_rollup_hdrs`       | `true`      | `false`      | `true`      | `false`     | `true`      | `false`     |
| `max_consumers`           | `100`       | `50`         | `200`       | `100`       | `100`       | `100`       |
| `max_msg_size`            | `1 MB`      | `1 MB`       | `1 MB`      | `1 MB`      | `1 MB`      | `1 MB`      |
| `max_msgs_per_subject`    | `100,000`   | `10,000`     | `50,000`    | `500,000`   | unlimited   | unlimited   |
| `max_msgs`                | `1,000,000` | `100,000`    | `500,000`   | `5,000,000` | unlimited   | `500,000`   |
| `max_bytes`               | `512 MB`    | `64 MB`      | `256 MB`    | `1 GB`      | `64 MB`     | `256 MB`    |
| `max_age`                 | `7 days`    | `3 minutes`  | `1 hour`    | `1 day`     | none        | `30 days`   |
| `duplicate_window`        | `2 minutes` | `30 seconds` | `2 minutes` | `2 minutes` | `2 minutes` | `2 minutes` |

`max_bytes` is what the account is charged for, not what the stream currently holds: JetStream counts it against the account's storage budget the moment the stream is created. A service that provisions events plus a DLQ reserves **768 MB**, and one that also uses ordered delivery reserves **1.75 GB**, so a 10 GB file store carries roughly a dozen services instead of one.

`discard` decides what a full stream does. Under `New` it rejects the publish and the producer gets a [`JetstreamPublishError`](/docs/reference/errors) with reason `stream-full`; under `Old` it accepts the publish and evicts the oldest message without telling anyone. Event, command and DLQ streams hold messages nobody has processed yet, so evicting one loses it: they use `New`. The DLQ has no per-subject limit, because every dead letter shares one subject and such a limit would cap the whole stream. Broadcast and ordered streams are rolling windows that consumers read rather than consume away, so they keep `Old`. NATS refuses `New` on a stream with `allow_msg_schedules`, so the schedule stream, and an event stream with scheduling turned on, keep `Old` whatever the override says. `discard_new_per_subject` applies the same rule to `max_msgs_per_subject`; without it, a subject at its own limit still evicts its oldest message. The transport turns it off by itself wherever NATS would refuse it: under `discard: Old` or without a positive `max_msgs_per_subject`.

`max_msg_size` matches the NATS server's own `max_payload` default of 1 MB. A larger value here has no effect until the server is reconfigured to accept larger payloads.

Sizes are binary: `1 MB` is 1,048,576 bytes, `512 MB` is 536,870,912 bytes. Durations are written with [`toNanos`](/docs/reference/module-configuration), so `max_age: toNanos(7, 'days')`.

What each kind is for:

- **Event** carries workqueue events. A message is removed once a consumer acks it.
- **Command** carries RPC requests in [JetStream RPC mode](/docs/patterns/rpc) only. It is short-lived: a request nobody answered within three minutes is a request nobody wants answered.
- **Broadcast** is one stream shared by every service. An hour of `max_age` gives a starting pod enough catch-up without letting config updates pile up. A service down for longer misses what aged out, so broadcast suits signals rather than business events; see [retention window](/docs/patterns/broadcast#retention-window).
- **Ordered** keeps messages for a day under `Limits` retention, because an ordered consumer replays a subject from the beginning instead of consuming it away.
- **Schedule** holds [recurring schedules](/docs/guides/recurring-schedules) and their ticks, and exists only when a handler declares `schedule`. It also sets `allow_msg_schedules` and `allow_msg_ttl`. `max_age` stays off because an aged-out holder silently stops its schedule; ticks expire through their own TTL instead.
- **DLQ** is created unless you pass `dlq: false`. Thirty days under `Limits` retention: reading a dead letter must not remove it. See [Dead Letter Queue](/docs/guides/dead-letter-queue#built-in-dlq-stream).

:::note S2 compression
[S2](https://github.com/klauspost/compress/tree/master/s2) is a Snappy-compatible codec with better ratios. It trades some CPU, depending on payload size and entropy, for less disk I/O and storage. Override per kind:

```typescript
import { StoreCompression } from '@nats-io/jetstream';

events: {
  stream: { compression: StoreCompression.None },
}
```

:::

:::tip Scheduling
To enable [message scheduling](/docs/guides/scheduling), add `allow_msg_schedules: true` to the event stream config. On a server too old for it, startup throws `JetstreamCapabilityError`; see [NATS server versions](/docs/getting-started/installation#nats-server-versions).
:::

## Consumer Defaults

Every durable consumer uses `ack_policy: Explicit`, `deliver_policy: All` and `replay_policy: Instant`. What differs:

| Property          | Event        | Command     | Broadcast    | Schedule     |
| ----------------- | ------------ | ----------- | ------------ | ------------ |
| `ack_wait`        | `10 seconds` | `5 minutes` | `10 seconds` | `10 seconds` |
| `max_deliver`     | `5`          | `1`         | `5`          | `5`          |
| `max_ack_pending` | `100`        | `100`       | `100`        | `100`        |

An event that fails five times is [dead-lettered](/docs/guides/dead-letter-queue). Between attempts the transport naks with a delay from the retry curve (`[2000, 10000, 30000, 60000]` ms), so the five attempts span about 100 seconds: long enough for a database failover or a restarting dependency to clear, short enough that a message no retry can fix reaches the DLQ within two minutes.

The delay is applied client-side, which leaves `ack_wait` at its full value, so a slow handler is not redelivered while it still runs. Tune the curve per kind with [`retry`](/docs/reference/module-configuration#retry), or pass `false` to nak immediately.

A command is delivered once and never retried, so an RPC failure reaches the caller instead of being repeated behind their back.

:::note
Ordered consumers have no durable configuration: they are ephemeral and managed by the `@nats-io/jetstream` client.
:::

## Connection Defaults

| Property               | Value  | Notes                                  |
| ---------------------- | ------ | -------------------------------------- |
| `maxReconnectAttempts` | `-1`   | Unlimited reconnection attempts        |
| `reconnectTimeWait`    | `1000` | 1 second between reconnection attempts |

The transport keeps reconnecting after a network failure. Override either value through [`connectionOptions`](/docs/reference/module-configuration#connectionoptions).

## Timeouts

| Timeout                           | Default      | Constant                        |
| --------------------------------- | ------------ | ------------------------------- |
| Core RPC (standard request-reply) | `30 seconds` | `DEFAULT_RPC_TIMEOUT`           |
| JetStream RPC (persistent)        | `3 minutes`  | `DEFAULT_JETSTREAM_RPC_TIMEOUT` |
| Graceful shutdown                 | `10 seconds` | `DEFAULT_SHUTDOWN_TIMEOUT`      |

The JetStream RPC timeout is longer on purpose: the message is persisted to a stream first, and the consumer may take a while to reach it.

The shutdown value bounds, per NATS connection, the wait for handlers still running and the `drain()` that follows. The drain keeps the last part of the budget, half of it but at most 2 seconds, and when the budget runs out the transport closes the connection. Set it above your slowest handler plus that reserve. See [Graceful Shutdown](/docs/guides/graceful-shutdown).

## Replicas in production

The default `num_replicas: 1` suits development and single-node NATS. **On a production cluster, set `num_replicas: 3`** so data survives a node failure:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://nats-1:4222', 'nats://nats-2:4222', 'nats://nats-3:4222'],
  events: { stream: { num_replicas: 3 } },
  broadcast: { stream: { num_replicas: 3 } },
  ordered: { stream: { num_replicas: 3 } },
  schedule: { stream: { num_replicas: 3 } },
  rpc: { mode: 'jetstream', stream: { num_replicas: 3 } },
  dlq: { stream: { num_replicas: 3 } },
  metadata: { replicas: 3 },
});
```

:::tip
`num_replicas` is mutable: NATS adds or removes replicas on an existing stream without downtime or recreation.
:::

When the server runs clustered JetStream, the transport logs one warning at startup naming every stream, and the [handler metadata](/docs/patterns/handler-metadata) KV bucket, left at the default single replica. Losing the node that holds such a stream makes it unavailable, and losing its disk loses its messages. Set `num_replicas: 3` to fix it. To keep one replica on purpose, say on a staging cluster, set `num_replicas: 1` explicitly and the warning stays quiet. Streams under `management: Manual` are never checked, since their replicas are not the transport's to choose.

## Immutable vs mutable stream properties

### Mutable (can be changed at any time)

`num_replicas`, `max_age`, `max_bytes`, `max_msgs`, `max_msg_size`, `max_msgs_per_subject`, `discard`, `discard_new_per_subject`, `duplicate_window`, `subjects`, `compression`, `description`, `allow_rollup_hdrs`, `allow_direct`

The transport applies mutable changes on startup: update the value in `forRoot()` and restart.

### Enable-only (can be turned on, but never off)

A normal update enables these on an existing stream, without recreating it or losing messages. Once on, they cannot be turned off.

| Property              | Default | Notes                                                                                  |
| --------------------- | ------- | -------------------------------------------------------------------------------------- |
| `allow_msg_schedules` | `false` | Enables [message scheduling](/docs/guides/scheduling). `true` on the schedule stream   |
| `allow_msg_ttl`       | `false` | Enables [per-message TTL](/docs/guides/per-message-ttl). `true` on the schedule stream |
| `deny_delete`         | `false` | Prevents message deletion through the API                                              |
| `deny_purge`          | `false` | Prevents stream purging through the API                                                |

### Immutable (locked after creation)

| Property    | Default                   | Migratable | Notes                                                      |
| ----------- | ------------------------- | ---------- | ---------------------------------------------------------- |
| `name`      | derived from service name | No         | Cannot be renamed                                          |
| `retention` | `Workqueue` or `Limits`   | **No**     | Controlled by the transport: a mismatch is always an error |
| `storage`   | `File`                    | **Yes**    | Migrated with `provisioning.allowDestructiveMigration`     |

The transport migrates `storage` through blue-green stream recreation. The [Stream Migration guide](/docs/guides/stream-migration) covers how it works, rolling updates and limitations.

:::warning retention is never migratable
`retention` follows the kind (`Workqueue` for events, commands and schedules, `Limits` for broadcast, ordered and DLQ). A running stream with a different policy fails startup, whatever `provisioning.allowDestructiveMigration` says.
:::

## Exported constants

Every default above is exported as a typed constant, for composing overrides or writing tests.

**Stream and consumer defaults:**

| Constant                            | Contents                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `DEFAULT_EVENT_STREAM_CONFIG`       | Event (workqueue) stream defaults                                                       |
| `DEFAULT_BROADCAST_STREAM_CONFIG`   | Broadcast stream defaults (shared `broadcast-stream`)                                   |
| `DEFAULT_ORDERED_STREAM_CONFIG`     | Ordered stream defaults                                                                 |
| `DEFAULT_SCHEDULE_STREAM_CONFIG`    | Schedule stream defaults                                                                |
| `DEFAULT_COMMAND_STREAM_CONFIG`     | JetStream RPC command stream defaults                                                   |
| `DEFAULT_DLQ_STREAM_CONFIG`         | [Dead Letter Queue](/docs/guides/dead-letter-queue#built-in-dlq-stream) stream defaults |
| `DEFAULT_EVENT_CONSUMER_CONFIG`     | Event consumer defaults                                                                 |
| `DEFAULT_BROADCAST_CONSUMER_CONFIG` | Broadcast consumer defaults                                                             |
| `DEFAULT_COMMAND_CONSUMER_CONFIG`   | JetStream RPC command consumer defaults                                                 |
| `DEFAULT_SCHEDULE_CONSUMER_CONFIG`  | Schedule tick consumer defaults                                                         |

**Timeouts and the handler metadata registry:**

| Constant                        | Value                | Meaning                               |
| ------------------------------- | -------------------- | ------------------------------------- |
| `DEFAULT_RPC_TIMEOUT`           | `30_000`             | Core RPC timeout, ms                  |
| `DEFAULT_JETSTREAM_RPC_TIMEOUT` | `180_000`            | JetStream RPC timeout, ms             |
| `DEFAULT_SHUTDOWN_TIMEOUT`      | `10_000`             | Graceful shutdown drain, ms           |
| `DEFAULT_METADATA_BUCKET`       | `'handler_registry'` | KV bucket holding handler entries     |
| `DEFAULT_METADATA_REPLICAS`     | `1`                  | KV bucket replicas                    |
| `DEFAULT_METADATA_HISTORY`      | `1`                  | KV history depth: latest only         |
| `DEFAULT_METADATA_TTL`          | `30_000`             | Entry TTL, refreshed by heartbeat, ms |
| `MIN_METADATA_TTL`              | `5_000`              | Lowest TTL the module accepts, ms     |

**Other:**

- `RESERVED_HEADERS`; the `Set<string>` of header names blocked by `JetstreamRecordBuilder.setHeader()`. See [Record Builder](/docs/guides/record-builder#headers-the-transport-sets-itself).

```typescript
import { DEFAULT_EVENT_STREAM_CONFIG, toNanos } from '@horizon-republic/nestjs-jetstream';

events: {
  stream: { ...DEFAULT_EVENT_STREAM_CONFIG, max_age: toNanos(14, 'days') },
}
```
