---
sidebar_position: 2
sidebar_label: "Default Configs"
title: "Default Stream & Consumer Configs for NATS JetStream"
description: "Default stream, consumer, and connection settings for every NestJS JetStream StreamKind (event, broadcast, ordered, command, DLQ)."
schema:
  type: Article
  headline: "Default Stream & Consumer Configs for NATS JetStream"
  description: "Default stream, consumer, and connection settings for every NestJS JetStream StreamKind (event, broadcast, ordered, command, DLQ)."
  datePublished: "2026-03-21"
  dateModified: "2026-07-27"
---

# Default Configs

Every stream and consumer the transport creates starts from the values below, taken from the source. Override any of them through [module configuration](/docs/reference/module-configuration).

## Stream Defaults

Every stream is created with `storage: File`, `num_replicas: 1` (see [replicas in production](#replicas-in-production)), `discard: Old`, `allow_direct: true` and `compression: S2`. What differs per kind:

| Property               | Event       | Command      | Broadcast   | Ordered     | DLQ         |
| ---------------------- | ----------- | ------------ | ----------- | ----------- | ----------- |
| `retention`            | `Workqueue` | `Workqueue`  | `Limits`    | `Limits`    | `Limits`    |
| `allow_rollup_hdrs`    | `true`      | `false`      | `true`      | `false`     | `false`     |
| `max_consumers`        | `100`       | `50`         | `200`       | `100`       | `100`       |
| `max_msg_size`         | `1 MB`      | `1 MB`       | `1 MB`      | `1 MB`      | `1 MB`      |
| `max_msgs_per_subject` | `100,000`   | `10,000`     | `50,000`    | `500,000`   | `50,000`    |
| `max_msgs`             | `1,000,000` | `100,000`    | `500,000`   | `5,000,000` | `500,000`   |
| `max_bytes`            | `512 MB`    | `64 MB`      | `256 MB`    | `1 GB`      | `256 MB`    |
| `max_age`              | `7 days`    | `3 minutes`  | `1 hour`    | `1 day`     | `30 days`   |
| `duplicate_window`     | `2 minutes` | `30 seconds` | `2 minutes` | `2 minutes` | `2 minutes` |

`max_bytes` is what the account is charged for, not what the stream currently holds: JetStream counts it against the account's storage budget the moment the stream is created. A service that provisions events plus a DLQ reserves **768 MB**, and one that also uses ordered delivery reserves **1.75 GB**, so a 10 GB file store carries roughly a dozen services rather than one.

`max_msg_size` matches the NATS server's own `max_payload` default of 1 MB. A larger value here has no effect until the server is reconfigured to accept larger payloads.

Sizes are binary: `1 MB` is 1,048,576 bytes, `512 MB` is 536,870,912 bytes. Durations are written with [`toNanos`](/docs/reference/module-configuration), so `max_age: toNanos(7, 'days')`.

What each kind is for:

- **Event** carries workqueue events. A message is removed once a consumer acks it.
- **Command** carries RPC requests in [JetStream RPC mode](/docs/patterns/rpc) only. Everything about it is short-lived, because a request nobody answered within three minutes is a request nobody wants answered.
- **Broadcast** is one stream shared by every service. An hour of `max_age` is enough catch-up for a pod that just started and short enough that config updates do not accumulate.
- **Ordered** keeps messages for a day under `Limits` retention, because an ordered consumer replays a subject from the beginning rather than consuming it away.
- **DLQ** is created unless you pass `dlq: false`. Thirty days under `Limits` retention: reading a dead letter must not remove it. See [Dead Letter Queue](/docs/guides/dead-letter-queue#built-in-dlq-stream).

:::note S2 compression
[S2](https://github.com/klauspost/compress/tree/master/s2) is a Snappy-compatible codec with better ratios. It cuts disk I/O and storage for CPU that varies with payload entropy and size, and needs NATS Server >= 2.10 (see [runtime requirements](/docs/getting-started/installation#runtime-requirements)). Override per kind:

```typescript
import { StoreCompression } from '@nats-io/jetstream';

events: {
  stream: { compression: StoreCompression.None },
}
```

:::

:::tip Scheduling
To enable [message scheduling](/docs/guides/scheduling), add `allow_msg_schedules: true` to the event stream config. This requires NATS Server >= 2.12.
:::

## Consumer Defaults

Every durable consumer uses `ack_policy: Explicit`, `deliver_policy: All` and `replay_policy: Instant`. What differs:

| Property          | Event        | Command     | Broadcast    |
| ----------------- | ------------ | ----------- | ------------ |
| `ack_wait`        | `10 seconds` | `5 minutes` | `10 seconds` |
| `max_deliver`     | `3`          | `1`         | `3`          |
| `max_ack_pending` | `100`        | `100`       | `100`        |
| `backoff`         | `2s, 10s`    | -           | `2s, 10s`    |

An event that fails three times is [dead-lettered](/docs/guides/dead-letter-queue). Between attempts the transport naks with a delay taken from the retry curve, so the three attempts span roughly twelve seconds instead of burning out in milliseconds; `backoff` carries the same curve for redeliveries the server schedules itself after `ack_wait` expires. Tune it with `events.retry`, or pass `false` to nak immediately.

A command is delivered once and never retried, so an RPC failure reaches the caller instead of being repeated behind their back.

:::note
Ordered consumers have no durable configuration. They are ephemeral and managed entirely by the `@nats-io/jetstream` client library.
:::

## Connection Defaults

The transport applies the following connection defaults for production resilience:

| Property               | Value  | Notes                                  |
| ---------------------- | ------ | -------------------------------------- |
| `maxReconnectAttempts` | `-1`   | Unlimited reconnection attempts        |
| `reconnectTimeWait`    | `1000` | 1 second between reconnection attempts |

These defaults ensure the transport automatically recovers from transient network failures without manual intervention. Override them via `connectionOptions` in `forRoot()`:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  connectionOptions: {
    maxReconnectAttempts: 10,   // limit to 10 attempts
    reconnectTimeWait: 2_000,  // 2 seconds between attempts
  },
})
```

## RPC Timeouts

| Mode                               | Default Timeout | Constant                        |
| ---------------------------------- | --------------- | ------------------------------- |
| Core (standard NATS request-reply) | `30 seconds`    | `DEFAULT_RPC_TIMEOUT`           |
| JetStream (persistent RPC)         | `3 minutes`     | `DEFAULT_JETSTREAM_RPC_TIMEOUT` |

The JetStream RPC timeout is intentionally longer because messages are persisted to a stream and the consumer may take time to process them.

## Graceful Shutdown Timeout

| Property         | Value        |
| ---------------- | ------------ |
| Shutdown timeout | `10 seconds` |

On shutdown, the transport calls `drain()` on the NATS connection and waits up to 10 seconds for it to complete before forcing the connection closed. Increase this timeout if your handlers have long-running I/O that must finish cleanly.

## Replicas in production

The default `num_replicas: 1` is suitable for development and single-node NATS. **For production NATS clusters, set `num_replicas: 3`** to ensure data survives node failures via Raft consensus:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://nats-1:4222', 'nats://nats-2:4222', 'nats://nats-3:4222'],
  events: { stream: { num_replicas: 3 } },
  broadcast: { stream: { num_replicas: 3 } },
  ordered: { stream: { num_replicas: 3 } },
  rpc: { mode: 'jetstream', stream: { num_replicas: 3 } },
});
```

:::tip
`num_replicas` can be changed on an existing stream, NATS will add or remove replicas automatically. No downtime or stream recreation required.
:::

## Immutable vs mutable stream properties

NATS JetStream divides stream configuration into properties that can be updated on an existing stream and properties that are **locked at creation time**.

### Mutable (can be changed at any time)

`num_replicas`, `max_age`, `max_bytes`, `max_msgs`, `max_msg_size`, `max_msgs_per_subject`, `discard`, `duplicate_window`, `subjects`, `compression`, `description`, `allow_rollup_hdrs`, `allow_direct`

The transport applies mutable changes automatically on startup, just update the value in `forRoot()` and restart the service.

### Enable-only (can be turned on, but never off)

These properties can be **enabled** on an existing stream via a normal update, but once enabled they cannot be disabled. No stream recreation required.

| Property              | Default | Notes                                                                                 |
| --------------------- | ------- | ------------------------------------------------------------------------------------- |
| `allow_msg_schedules` | `false` | Enable [message scheduling](/docs/guides/scheduling): safe to add to existing streams |
| `allow_msg_ttl`       | `false` | Enable per-message TTL                                                                |
| `deny_delete`         | `false` | Prevent message deletion via API                                                      |
| `deny_purge`          | `false` | Prevent stream purging via API                                                        |

:::tip Enabling scheduling on existing streams
You can safely add `allow_msg_schedules: true` to an existing stream config; NATS applies this as a regular update. Uptime, messages and the stream itself all survive. Just update `forRoot()` and restart.
:::

### Immutable (locked after creation)

| Property    | Default                   | Migratable | Notes                                                      |
| ----------- | ------------------------- | ---------- | ---------------------------------------------------------- |
| `name`      | derived from service name | No         | Cannot be renamed                                          |
| `retention` | `Workqueue` or `Limits`   | **No**     | Controlled by the transport: a mismatch is always an error |
| `storage`   | `File`                    | **Yes**    | Can be migrated with `allowDestructiveMigration: true`     |

The transport can automatically migrate `storage` via blue-green stream recreation. See the full **[Stream Migration guide](/docs/guides/stream-migration)** for how it works, rolling update behavior, performance benchmarks, and limitations.

:::warning retention is never migratable
`retention` is controlled by the transport (`Workqueue` for events/commands, `Limits` for broadcast/ordered). A mismatch between the running stream and the expected retention policy always throws an error on startup, regardless of `allowDestructiveMigration`.
:::

## Overriding Defaults

All stream and consumer defaults can be overridden in `forRoot()` options. User-provided values are merged on top of the defaults: you only need to specify the properties you want to change.

```typescript
import { RetentionPolicy, StorageType } from '@nats-io/jetstream';
import { JetstreamModule, toNanos } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  events: {
    stream: {
      storage: StorageType.Memory,   // override just storage type
      max_age: toNanos(3, 'days'), // 3 days instead of 7
    },
    consumer: {
      max_deliver: 5, // 5 retries instead of 3
    },
  },
  rpc: {
    mode: 'jetstream',
    timeout: 60_000, // 1 minute instead of 3
    stream: {
      max_msg_size: 1024 * 1024, // 1 MB limit for RPC payloads
    },
  },
});
```

See [Module Configuration](/docs/reference/module-configuration) for the full options reference.

## Exported constants

Every default above is exposed as a typed constant from the package, so you can import and reuse it when composing overrides programmatically or writing tests.

**Stream and consumer defaults:**

| Constant                            | Contents                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `DEFAULT_EVENT_STREAM_CONFIG`       | Event (workqueue) stream defaults                                                       |
| `DEFAULT_BROADCAST_STREAM_CONFIG`   | Broadcast stream defaults (shared `broadcast-stream`)                                   |
| `DEFAULT_ORDERED_STREAM_CONFIG`     | Ordered stream defaults                                                                 |
| `DEFAULT_COMMAND_STREAM_CONFIG`     | JetStream RPC command stream defaults                                                   |
| `DEFAULT_DLQ_STREAM_CONFIG`         | [Dead Letter Queue](/docs/guides/dead-letter-queue#built-in-dlq-stream) stream defaults |
| `DEFAULT_EVENT_CONSUMER_CONFIG`     | Event consumer defaults                                                                 |
| `DEFAULT_BROADCAST_CONSUMER_CONFIG` | Broadcast consumer defaults                                                             |
| `DEFAULT_COMMAND_CONSUMER_CONFIG`   | JetStream RPC command consumer defaults                                                 |

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
