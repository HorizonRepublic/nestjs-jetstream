---
sidebar_position: 6
title: "Performance Tuning"
description: "Tune ackWait, maxAckPending, batch sizes, and ack extension for high-throughput workloads."
schema:
  type: Article
  headline: "Performance Tuning"
  description: "Tune ackWait, maxAckPending, batch sizes, and ack extension for high-throughput workloads."
  datePublished: "2026-03-26"
  dateModified: "2026-10-30"
---

# Performance Tuning

> **Use when:** throughput or latency is not where you want it.
> **You get:** the backpressure and concurrency knobs in the order they matter, and how to measure the result.

## Backpressure & flow control

Consumers pull, so the client decides how fast messages arrive:

```text
NATS Server -> pull consumer (max_ack_pending) -> consume() buffer -> concurrency gate -> handler -> ack -> frees slot
```

The primary knob is the consumer's `max_ack_pending`: the cap on messages delivered but not yet acknowledged. At the cap the server stops delivering until acks free a slot.

### Configuration options

| Option                       | Default                    | Effect                            |
| ---------------------------- | -------------------------- | --------------------------------- |
| `consumer.max_ack_pending`   | 100                        | Max in-flight unacked messages    |
| `consumer.ack_wait`          | 10s (events) / 5min (RPC)  | Ack deadline before redelivery    |
| `concurrency`                | unlimited                  | Limits parallel handler execution |
| `consume.max_messages`       | 100 (`@nats-io/jetstream`) | Internal prefetch buffer size     |
| `consume.threshold_messages` | 75% of max_messages        | Auto-refill trigger               |

### How these interact

- **`max_ack_pending`** is the ceiling on unacked messages.
- **`concurrency`** caps parallel handlers. Below `max_ack_pending`, the excess waits in the internal buffer, kept alive until a slot frees.
- **`consume.max_messages`** and **`consume.threshold_messages`** size the prefetch batch the client requests and decide when it asks for more.

For most workloads, `max_ack_pending` and `concurrency` are enough.

## Consume options

`consume` passes options to the `@nats-io/jetstream` `consume()` call, which decides how aggressively the client pulls:

```typescript
events: {
  consume: {
    max_messages: 200,          // prefetch up to 200 messages
    threshold_messages: 150,    // request more when buffer drops below 150
    idle_heartbeat: 10_000,     // 10s heartbeat to detect stalled consumers
  },
}
```

With `idle_heartbeat` the server sends heartbeats while it has nothing to deliver, so the client notices a broken subscription and re-establishes it.

## Concurrency control

The `concurrency` option caps how many messages the router has in flight at once. Anything beyond the cap queues FIFO and drains as handlers settle. Without it, every pulled message is dispatched immediately.

```typescript
events: {
  concurrency: 200,  // max 200 handlers running in parallel
}
```

Set `concurrency` at or below `max_ack_pending`; above it, the server-side cap is the bottleneck anyway. The cap protects downstream resources (databases, external APIs) while the prefetch buffer stays full.

A queued message is kept alive with `msg.working()` until a slot frees, whether or not `ackExtension` is on, so a backlog that takes longer than `ack_wait` to drain is not redelivered. The time in the queue does not count against `ackExtension.maxDuration`, which bounds the handler alone.

A queue only waits while handlers make progress. When no handler has started or finished for `ackExtension.maxDuration` (5 minutes by default, ack extension on or off), every slot is taken to be held by a hung handler: the pod logs a warning and naks its queue so other pods take it, and naks every new message until a slot frees again. Each hand-back counts as a delivery towards `max_deliver`. With `maxDuration: Infinity` the queue waits indefinitely.

The client refills its prefetch as messages arrive, not as handlers finish, so `consume.max_messages` does not bound the queue; `max_ack_pending` does. It is shared by every replica of the service, so a busy replica can hold messages an idle one could take. With several replicas, keep `max_ack_pending` near `concurrency` times the replica count.

In [JetStream RPC](/docs/patterns/rpc) mode, `rpc.concurrency` counts commands awaiting a reply. A command whose handler outlives `rpc.timeout` is terminated and gives its slot back at the deadline, so hung handlers cannot stall the command consumer. The handler itself keeps running, so while handlers are stuck past the timeout, more than `concurrency` of them run at once. Bound the work inside the handler if that matters downstream.

## Ack extension

A handler that outlives `ack_wait` gets its message redelivered while it is still working. `ackExtension` extends the deadline while the handler runs, which fits handlers whose duration you cannot predict: slow external APIs, long [JetStream-mode RPC](/docs/patterns/rpc) calls.

```typescript
events: {
  consumer: { ack_wait: toNanos(30, 'seconds') },
  ackExtension: true,
}
```

The transport calls `msg.working()` every half `ack_wait`, which resets the deadline on the server.

Extension stops after 5 minutes per message, so a hung handler cannot hold its message forever. The transport logs a warning naming the subject, and the server redelivers the message once `ack_wait` runs out. The first handler keeps running, and keeps its concurrency slot, until it returns. On the last delivery, the same limit decides when a running handler counts as hung and its message goes to the [dead-letter queue](/docs/guides/dead-letter-queue#deliveries-no-handler-settled). Set the limit to the slowest legitimate run, or `Infinity` to remove it:

```typescript
events: {
  consumer: { ack_wait: toNanos(30, 'seconds') },
  ackExtension: { maxDuration: 20 * 60_000 }, // interval still derived from ack_wait
}
```

`interval` in the same object sets the extension period in milliseconds instead.

For JetStream RPC the RPC timeout bounds how long the caller waits, and `ackExtension` keeps the command message alive independently. Size both for the expected handler duration.

## S2 compression

All streams default to [S2 compression](https://github.com/klauspost/compress/tree/master/s2), a Snappy-compatible codec that trades some CPU for less disk I/O and storage. The cost depends on payload entropy, message size and CPU, so measure it. [Default Configs](/docs/reference/default-configs#stream-defaults) shows how to override it per stream kind.

## Connection defaults

The transport reconnects without limit, once per second (`maxReconnectAttempts: -1`, `reconnectTimeWait: 1000`). See [Connection Defaults](/docs/reference/default-configs#connection-defaults) to override.

## Complete example

Up to 500 unacked events with 200 handled in parallel, ack extension on long event and RPC handlers, 50 concurrent broadcast handlers, and a 60-second JetStream RPC timeout:

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

## Performance expectations

The library publishes no benchmark figures, so treat any number you see elsewhere as a guess and measure your own workload. What holds without numbers:

- **The bottleneck is almost always the handler**: database writes, external API calls, serialization. Profile it first.
- **Core NATS RPC is the faster of the two RPC modes**: it skips the stream write. JetStream RPC adds a stream persist and an inbox reply, and in exchange the command survives a server restart.
- **Event throughput scales with [`concurrency`](#concurrency-control)** until a downstream dependency saturates. CPU-bound handlers scale with cores, while I/O-bound handlers gain from higher `concurrency` and `max_ack_pending`.
- **Broadcast does not slow consumers down**: each service processes its copy through its own consumer.

### Measuring your throughput

1. **NATS monitoring:** enable the [monitoring endpoint](https://docs.nats.io/running-a-nats-service/configuration/monitoring) (`-m 8222`) and watch the `msgs_in` / `msgs_out` rates.
2. **Consumer lag:** `nats consumer info <stream> <consumer>` shows "Num Pending".
3. **Application metrics:** the built-in [Prometheus metrics](/docs/observability/metrics) cover handler duration, consumer lag and errors.

## See also

- [Default Configs](/docs/reference/default-configs): all stream, consumer, and connection defaults
- [Module Configuration](/docs/reference/module-configuration): where to set these options
- [Troubleshooting](/docs/guides/troubleshooting#consumer-issues): diagnosing consumer lag
