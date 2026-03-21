---
sidebar_position: 2
title: Default Configs
---

# Default Configs

The transport ships with production-ready defaults for every stream and consumer type. This page lists the exact values from the source code. All defaults can be overridden via [module configuration](/docs/getting-started/module-configuration).

## Stream Defaults

All streams share a common base configuration:

| Property | Value |
|----------|-------|
| `retention` | `Workqueue` (overridden per type below) |
| `storage` | `File` |
| `num_replicas` | `1` |
| `discard` | `Old` |
| `allow_direct` | `true` |
| `compression` | `None` |

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
| `max_age` | `7 days` | 604,800,000 ms |
| `duplicate_window` | `2 minutes` | 120,000 ms |

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
| `max_age` | `3 minutes` | 180,000 ms |
| `duplicate_window` | `30 seconds` | 30,000 ms |

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
| `max_age` | `1 day` | 86,400,000 ms |
| `duplicate_window` | `2 minutes` | 120,000 ms |

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
| `max_age` | `1 day` | 86,400,000 ms |
| `duplicate_window` | `2 minutes` | 120,000 ms |

## Consumer Defaults

### Event Consumer

| Property | Value | Notes |
|----------|-------|-------|
| `ack_wait` | `10 seconds` | 10,000 ms (10s) |
| `max_deliver` | `3` | Message moves to dead-letter after 3 failed attempts |
| `max_ack_pending` | `100` | |
| `ack_policy` | `Explicit` | |
| `deliver_policy` | `All` | |
| `replay_policy` | `Instant` | |

### Command Consumer

| Property | Value | Notes |
|----------|-------|-------|
| `ack_wait` | `5 minutes` | 300,000 ms (5min) |
| `max_deliver` | `1` | No retries — RPC failures propagate immediately |
| `max_ack_pending` | `100` | |
| `ack_policy` | `Explicit` | |
| `deliver_policy` | `All` | |
| `replay_policy` | `Instant` | |

### Broadcast Consumer

| Property | Value | Notes |
|----------|-------|-------|
| `ack_wait` | `10 seconds` | 10,000 ms (10s) |
| `max_deliver` | `3` | |
| `max_ack_pending` | `100` | |
| `ack_policy` | `Explicit` | |
| `deliver_policy` | `All` | |
| `replay_policy` | `Instant` | |

:::note
Ordered consumers do not have a durable consumer configuration. They are ephemeral and managed entirely by the nats.js client library.
:::

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

## Overriding Defaults

All stream and consumer defaults can be overridden in `forRoot()` options. User-provided values are merged on top of the defaults — you only need to specify the properties you want to change.

```typescript
import { RetentionPolicy, StorageType } from 'nats';

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
