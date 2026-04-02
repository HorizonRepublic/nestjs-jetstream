---
sidebar_position: 2
title: Default Configs
schema:
  type: Article
  headline: Default Configs
  description: "Default stream and consumer configurations for every StreamKind."
  datePublished: "2026-03-21"
  dateModified: "2026-04-02"
---

# Default Configs

The transport ships with production-ready defaults for every stream and consumer type. This page lists the exact values from the source code. All defaults can be overridden via [module configuration](/docs/getting-started/module-configuration).

## Stream Defaults

All streams share a common base configuration:

| Property | Value |
|----------|-------|
| `retention` | `Workqueue` (overridden per type below) |
| `storage` | `File` |
| `num_replicas` | `1` (see [production recommendation](#replicas-in-production) below) |
| `discard` | `Old` |
| `allow_direct` | `true` |
| `compression` | `S2` |

:::info S2 Compression
All streams default to [Snappy S2 compression](https://github.com/nats-io/nats-server). This reduces disk I/O and storage with negligible CPU overhead (~1-3%). Requires NATS Server >= 2.10 (see [runtime requirements](/docs/getting-started/installation#runtime-requirements)). Override per stream kind:

```typescript
import { StoreCompression } from '@nats-io/jetstream';

events: {
  stream: { compression: StoreCompression.None }, // disable for event streams
}
```

:::

### Event Stream

Workqueue retention — each message is removed after being acknowledged by a consumer.

| Property | Value | Notes |
|----------|-------|-------|
| `retention` | `Workqueue` | |
| `storage` | `File` | |
| `num_replicas` | `1` | |
| `allow_rollup_hdrs` | `true` | |
| `max_consumers` | `100` | |
| `max_msg_size` | `10 MB` | 10,485,760 bytes |
| `max_msgs_per_subject` | `5,000,000` | |
| `max_msgs` | `50,000,000` | |
| `max_bytes` | `5 GB` | 5,368,709,120 bytes |
| `max_age` | `7 days` | `toNanos(7, 'days')` |
| `duplicate_window` | `2 minutes` | `toNanos(2, 'minutes')` |

:::tip Scheduling
To enable [message scheduling](/docs/guides/scheduling), add `allow_msg_schedules: true` to the event stream config. This requires NATS Server >= 2.12.
:::

### Command Stream

Short-lived RPC commands (JetStream RPC mode only).

| Property | Value | Notes |
|----------|-------|-------|
| `retention` | `Workqueue` | |
| `storage` | `File` | |
| `num_replicas` | `1` | |
| `allow_rollup_hdrs` | `false` | |
| `max_consumers` | `50` | |
| `max_msg_size` | `5 MB` | 5,242,880 bytes |
| `max_msgs_per_subject` | `100,000` | |
| `max_msgs` | `1,000,000` | |
| `max_bytes` | `100 MB` | 104,857,600 bytes |
| `max_age` | `3 minutes` | `toNanos(3, 'minutes')` |
| `duplicate_window` | `30 seconds` | `toNanos(30, 'seconds')` |

### Broadcast Stream

Limits retention — messages persist until the configured limits are reached. Shared across all services.

| Property | Value | Notes |
|----------|-------|-------|
| `retention` | `Limits` | |
| `storage` | `File` | |
| `num_replicas` | `1` | |
| `allow_rollup_hdrs` | `true` | |
| `max_consumers` | `200` | |
| `max_msg_size` | `10 MB` | 10,485,760 bytes |
| `max_msgs_per_subject` | `1,000,000` | |
| `max_msgs` | `10,000,000` | |
| `max_bytes` | `2 GB` | 2,147,483,648 bytes |
| `max_age` | `1 hour` | `toNanos(1, 'hours')` |
| `duplicate_window` | `2 minutes` | `toNanos(2, 'minutes')` |

:::info Changed in this release
`max_age` reduced from 1 day to 1 hour. Broadcast messages (config propagation, cache invalidation, feature flags) are relevant for minutes, not days. 1 hour provides sufficient catch-up window for new instances while reducing unnecessary storage. This is a mutable property — existing streams update automatically on next startup.
:::

### Ordered Stream

Limits retention for strict sequential delivery. Ordered consumers are ephemeral.

| Property | Value | Notes |
|----------|-------|-------|
| `retention` | `Limits` | |
| `storage` | `File` | |
| `num_replicas` | `1` | |
| `allow_rollup_hdrs` | `false` | |
| `max_consumers` | `100` | |
| `max_msg_size` | `10 MB` | 10,485,760 bytes |
| `max_msgs_per_subject` | `5,000,000` | |
| `max_msgs` | `50,000,000` | |
| `max_bytes` | `5 GB` | 5,368,709,120 bytes |
| `max_age` | `1 day` | `toNanos(1, 'days')` |
| `duplicate_window` | `2 minutes` | `toNanos(2, 'minutes')` |

## Consumer Defaults

### Event Consumer

| Property | Value | Notes |
|----------|-------|-------|
| `ack_wait` | `10 seconds` | `toNanos(10, 'seconds')` |
| `max_deliver` | `3` | Message moves to dead-letter after 3 failed attempts |
| `max_ack_pending` | `100` | |
| `ack_policy` | `Explicit` | |
| `deliver_policy` | `All` | |
| `replay_policy` | `Instant` | |

### Command Consumer

| Property | Value | Notes |
|----------|-------|-------|
| `ack_wait` | `5 minutes` | `toNanos(5, 'minutes')` |
| `max_deliver` | `1` | No retries — RPC failures propagate immediately |
| `max_ack_pending` | `100` | |
| `ack_policy` | `Explicit` | |
| `deliver_policy` | `All` | |
| `replay_policy` | `Instant` | |

### Broadcast Consumer

| Property | Value | Notes |
|----------|-------|-------|
| `ack_wait` | `10 seconds` | `toNanos(10, 'seconds')` |
| `max_deliver` | `3` | |
| `max_ack_pending` | `100` | |
| `ack_policy` | `Explicit` | |
| `deliver_policy` | `All` | |
| `replay_policy` | `Instant` | |

:::note
Ordered consumers do not have a durable consumer configuration. They are ephemeral and managed entirely by the `@nats-io/jetstream` client library.
:::

## Connection Defaults

The transport applies the following connection defaults for production resilience:

| Property | Value | Notes |
|----------|-------|-------|
| `maxReconnectAttempts` | `-1` | Unlimited reconnection attempts |
| `reconnectTimeWait` | `1000` | 1 second between reconnection attempts |

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

| Mode | Default Timeout | Constant |
|------|----------------|----------|
| Core (standard NATS request-reply) | `30 seconds` | `DEFAULT_RPC_TIMEOUT` |
| JetStream (persistent RPC) | `3 minutes` | `DEFAULT_JETSTREAM_RPC_TIMEOUT` |

The JetStream RPC timeout is intentionally longer because messages are persisted to a stream and the consumer may take time to process them.

## Graceful Shutdown Timeout

| Property | Value |
|----------|-------|
| Shutdown timeout | `10 seconds` |

The transport waits up to 10 seconds for in-flight messages to be processed before forcing shutdown via `drain()`.

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
`num_replicas` can be changed on an existing stream — NATS will add or remove replicas automatically. No downtime or stream recreation required.
:::

## Immutable vs mutable stream properties

NATS JetStream divides stream configuration into properties that can be updated on an existing stream and properties that are **locked at creation time**.

### Mutable (can be changed at any time)

`num_replicas`, `max_age`, `max_bytes`, `max_msgs`, `max_msg_size`, `max_msgs_per_subject`, `discard`, `duplicate_window`, `subjects`, `compression`, `description`, `allow_rollup_hdrs`, `allow_direct`

The transport applies mutable changes automatically on startup — just update the value in `forRoot()` and restart the service.

### Enable-only (can be turned on, but never off)

These properties can be **enabled** on an existing stream via a normal update, but once enabled they cannot be disabled. No stream recreation required.

| Property | Default | Notes |
|----------|---------|-------|
| `allow_msg_schedules` | `false` | Enable [message scheduling](/docs/guides/scheduling) — safe to add to existing streams |
| `allow_msg_ttl` | `false` | Enable per-message TTL |
| `deny_delete` | `false` | Prevent message deletion via API |
| `deny_purge` | `false` | Prevent stream purging via API |

:::tip Enabling scheduling on existing streams
You can safely add `allow_msg_schedules: true` to an existing stream config — NATS applies this as a regular update. No downtime, no message loss, no stream recreation. Just update `forRoot()` and restart.
:::

### Immutable (locked after creation)

| Property | Default | Migratable | Notes |
|----------|---------|-----------|-------|
| `name` | derived from service name | No | Cannot be renamed |
| `retention` | `Workqueue` or `Limits` | **No** | Controlled by the transport — a mismatch is always an error |
| `storage` | `File` | **Yes** | Can be migrated with `allowDestructiveMigration: true` |

#### Automatic stream migration

The transport can automatically recreate streams when `storage` needs to change. Enable `allowDestructiveMigration` to opt in:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  allowDestructiveMigration: true,
  events: { stream: { storage: StorageType.Memory } },
});
```

When an immutable conflict is detected:
- **`allowDestructiveMigration: false`** (default) — logs a warning, skips the immutable change, applies mutable changes only
- **`allowDestructiveMigration: true`** — recreates the stream via blue-green sourcing, preserving all messages

The migration uses NATS stream sourcing (server-side message copy) to avoid data loss. There is a brief window (milliseconds) during recreation where the stream does not exist — publishers may see temporary errors.

:::tip Rolling updates with migration
For most streams, migration completes in milliseconds and is safe during rolling updates. For very large streams (100k+ messages), consider scaling down to 1 replica before migrating or scheduling during a low-traffic window to avoid interference from other pods' self-healing consumers.
:::

:::caution retention is never migratable
`retention` is controlled by the transport (`Workqueue` for events/commands, `Limits` for broadcast/ordered). A mismatch between the running stream and the expected retention policy always throws an error on startup, regardless of `allowDestructiveMigration`.
:::

## Overriding Defaults

All stream and consumer defaults can be overridden in `forRoot()` options. User-provided values are merged on top of the defaults — you only need to specify the properties you want to change.

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

See [Module Configuration](/docs/getting-started/module-configuration) for the full options reference.
