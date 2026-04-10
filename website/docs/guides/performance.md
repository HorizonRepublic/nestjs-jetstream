---
sidebar_position: 6
title: "Performance Tuning"
schema:
  type: Article
  headline: "Performance Tuning"
  description: "Tune ackWait, maxAckPending, batch sizes, and ack extension for high-throughput workloads."
  datePublished: "2026-03-26"
  dateModified: "2026-04-11"
---

# Performance Tuning

This guide covers how to tune the transport for high-throughput workloads. The most impactful settings are backpressure controls and concurrency limits.

## Backpressure & flow control

Pull consumers provide **implicit backpressure** — the client controls how fast it pulls messages from the server. The transport never receives more messages than it can handle.

The message flow through the system:

```text
NATS Server → pull consumer (max_ack_pending) → consume() buffer → RxJS mergeMap (concurrency) → handler → ack → frees slot
```

The primary flow control knob is `max_ack_pending` on the consumer. It limits how many messages can be in-flight (delivered but not yet acknowledged) at any time. When the limit is reached, the server stops delivering new messages until existing ones are acknowledged — creating natural backpressure.

### Configuration options

| Option | Default | Effect |
|--------|---------|--------|
| `consumer.max_ack_pending` | 100 | Max in-flight unacked messages |
| `consumer.ack_wait` | 10s (events) / 5min (RPC) | Ack deadline before redelivery |
| `concurrency` | unlimited | Limits parallel handler execution |
| `consume.max_messages` | `@nats-io/jetstream` default | Internal prefetch buffer size |
| `consume.threshold_messages` | 75% of max_messages | Auto-refill trigger |

### How these interact

- **`max_ack_pending`** is the ceiling. The server will never deliver more than this many unacked messages.
- **`concurrency`** controls how many messages are processed in parallel by your handlers. If `concurrency` is lower than `max_ack_pending`, excess messages wait in the internal buffer.
- **`consume.max_messages`** and **`consume.threshold_messages`** control the prefetch buffer — how many messages the `@nats-io/jetstream` client requests from the server in a single batch and when it requests more.

For most workloads, tuning `max_ack_pending` and `concurrency` is sufficient.

## Consume options

The `consume` field controls the internal prefetch buffer used by the `@nats-io/jetstream` `consume()` call. These options determine how aggressively the client pulls messages from the server.

```typescript
events: {
  consume: {
    max_messages: 200,          // prefetch up to 200 messages
    threshold_messages: 150,    // request more when buffer drops below 150
    idle_heartbeat: 10_000,     // 10s heartbeat to detect stalled consumers
  },
}
```

The `idle_heartbeat` option enables the server to send periodic heartbeats when there are no messages to deliver. This allows the client to detect broken connections and re-establish the subscription.

## Concurrency control

The `concurrency` option limits the number of messages processed in parallel by the `mergeMap` operator in the message pipeline. Without it, all pulled messages are dispatched to handlers immediately.

```typescript
events: {
  concurrency: 200,  // max 200 handlers running in parallel
}
```

**Guideline:** Set `concurrency` at or below `max_ack_pending`. If `concurrency` exceeds `max_ack_pending`, the server-side limit will be the effective bottleneck anyway.

When `concurrency` is set, messages that exceed the limit are buffered in the RxJS pipeline until a handler slot frees up. This prevents overloading downstream resources (databases, external APIs) while still maintaining a full prefetch buffer.

## Ack extension

Long-running handlers risk exceeding the `ack_wait` deadline, causing redelivery of messages that are still being processed. The `ackExtension` option prevents this by periodically extending the ack deadline while the handler is running. This is the right knob when you can't predict handler duration upfront (e.g., slow external APIs, long-running [RPC JetStream mode](/docs/patterns/rpc) calls).

```typescript
events: {
  consumer: { ack_wait: toNanos(30, 'seconds') },
  ackExtension: true,
}
```

When enabled, the transport calls `msg.working()` at regular intervals (at half the `ack_wait` period) to signal that the message is still being processed. This resets the ack deadline on the server.

**When to use:**
- Handlers that call slow external APIs or run complex computations.
- RPC handlers with long timeouts — `ackExtension` keeps the command message alive while the handler runs.

**Interaction with RPC timeout:** For JetStream RPC, the RPC timeout determines how long the caller waits. The `ackExtension` keeps the server-side message alive independently. Both should be configured to accommodate the expected handler duration.

## S2 compression

All streams default to [Snappy S2 compression](https://github.com/nats-io/nats-server), reducing disk I/O and storage with modest CPU overhead. The actual cost varies with payload entropy, message size, and CPU — measure before assuming it's free. Requires **NATS Server >= 2.10**.

See [Default Configs — S2 Compression](/docs/reference/default-configs) for details and how to override per stream kind.

## Connection defaults

The transport configures unlimited reconnection attempts (`maxReconnectAttempts: -1`) and a 1-second reconnection interval by default. This ensures the application automatically recovers from transient network failures.

See [Default Configs — Connection Defaults](/docs/reference/default-configs#connection-defaults) for the full list and how to override.

## Complete example

A production-ready configuration tuned for high throughput:

```typescript
import { toNanos } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  events: {
    consumer: { max_ack_pending: 500, ack_wait: toNanos(30, 'seconds') },
    consume: { idle_heartbeat: 10_000 },
    concurrency: 200,
    ackExtension: true,
  },
  broadcast: {
    concurrency: 50,
  },
  rpc: {
    mode: 'jetstream',
    timeout: 60_000,
    concurrency: 50,
    ackExtension: true,
  },
})
```

This configuration:
- Allows up to 500 unacked event messages, with 200 processed in parallel.
- Extends ack deadlines automatically for long-running event and RPC handlers.
- Limits broadcast processing to 50 concurrent handlers.
- Sets a 60-second RPC timeout with ack extension to prevent redelivery during processing.

## Performance expectations

Published benchmark numbers for this library don't exist yet — any figures you see elsewhere are guesses. A real benchmark suite is planned (see the project issues), and this section will be updated with reproducible results when it lands.

In the meantime, here is what you can rely on without numbers:

- **The bottleneck is almost always the handler**, not the transport. Database writes, external API calls, and serialization dominate. Profile the handler first.
- **Core NATS RPC is the lowest-latency path of the two RPC modes** — no stream write, no inbox routing. Use it when in-cluster latency is the priority.
- **JetStream RPC adds a stream persist plus an inbox reply** on top of Core NATS. You trade a fixed amount of added latency for the guarantee that the command survives a server restart. Quantify the trade-off on your own workload before planning around it.
- **Event handler throughput scales with [`concurrency`](/docs/guides/performance#concurrency-control)** up to the point where your downstream dependencies become the bottleneck. CPU-bound handlers generally scale with core count; I/O-bound handlers benefit from higher concurrency and a larger `max_ack_pending`.
- **Broadcast is not a throughput hit** — each instance processes its copy independently through its own consumer.

### Measuring your throughput

1. **NATS monitoring:** Enable the [NATS monitoring endpoint](https://docs.nats.io/running-a-nats-service/configuration/monitoring) (`-m 8222`) and check `msgs_in`/`msgs_out` rates.
2. **Consumer lag:** `nats consumer info <stream> <consumer>` — watch "Num Pending" to detect falling behind.
3. **Application metrics:** Use [Lifecycle Hooks](/docs/guides/lifecycle-hooks) to emit Prometheus counters for `MessageRouted`, `Error`, and `RpcTimeout` events.

## See also

- [Default Configs](/docs/reference/default-configs) — all stream, consumer, and connection defaults
- [Module Configuration](/docs/getting-started/module-configuration) — where to set these options
- [Troubleshooting](/docs/guides/troubleshooting#consumer-issues) — diagnosing consumer lag
