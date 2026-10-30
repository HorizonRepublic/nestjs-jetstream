---
sidebar_position: 3
sidebar_label: "Edge Cases & FAQ"
title: "Edge Cases & FAQ: NestJS JetStream Transport"
description: "NestJS JetStream transport FAQ: publisher-only mode, consumer self-healing, NATS header limits, fire-and-forget messaging, and DeliverPolicy edge cases."
schema:
  type: Article
  headline: "Edge Cases & FAQ: NestJS JetStream Transport"
  description: "NestJS JetStream transport FAQ: publisher-only mode, consumer self-healing, NATS header limits, fire-and-forget messaging, and DeliverPolicy edge cases."
  datePublished: "2026-03-21"
  dateModified: "2026-10-30"
---

# Edge Cases & FAQ

> **Use when:** the transport did something you did not expect.
> **You get:** the non-obvious behaviors, each with the reason it works that way.

## Fire-and-Forget Messaging

**Q: How do I send a message without waiting for a response?**

`client.emit()` publishes to the event stream and returns without waiting for a handler. The message is durable because JetStream stores it:

```typescript
await lastValueFrom(this.client.emit('order.created', { orderId: '123' }));
```

For non-durable Core NATS `publish()`, run the standard `@nestjs/microservices` NATS transport alongside this library. Both can share one cluster.

## Publisher-Only Mode

**Q: My API gateway only publishes. Do I need consumers?**

No. `publisherOnly: true` skips streams and consumers and initializes only the client:

```typescript
JetstreamModule.forRoot({
  name: 'api-gateway',
  servers: ['nats://localhost:4222'],
  publisherOnly: true,
});
```

## Broadcast Stream is Shared

**Q: Why does the broadcast stream name have no service prefix?**

`broadcast-stream` is shared by every service in the cluster. Each service with a `broadcast: true` handler creates its own durable consumer on it, so every such service gets its own copy and tracks delivery independently: a `nak` affects only that service's consumer. The shared stream is also why it is never [migrated](/docs/guides/stream-migration#limitations). See [Broadcast Events](/docs/patterns/broadcast).

## Connection Failure Behavior

**Q: What happens if NATS is unreachable at startup?**

A critical connection (the default) **throws on startup**, so the application fails to bootstrap and Kubernetes or Docker Compose restarts it. A connection with `critical: false` starts in the background and retries with exponential backoff capped at 30 s (see [Multiple connections](/docs/guides/multi-connection#criticality)).

After the first successful connection the NATS client reconnects on its own, and the transport emits the `Disconnect` and `Reconnect` [lifecycle hooks](/docs/guides/lifecycle-hooks).

With a capped `maxReconnectAttempts`, the NATS client eventually gives up and closes the connection. Only clients recover from that: the next `emit()` or `send()` dials a new connection and the transport rebuilds its JetStream client and manager on it. Handlers do not move over. Consumers, Core RPC subscriptions, reply publishing and dead-letter advisories stay on the closed connection, so a connection that serves handlers reports `connected: false` in the [health check](/docs/guides/health-checks) from then on, even after a client dialled a new one. Let your orchestrator restart the process. A publish-only connection keeps reporting healthy once it has re-dialled.

## Observable Return Values in Handlers

**Q: What happens if my handler returns an Observable?**

The transport subscribes and uses the **first emitted value** as the result, for event and RPC handlers alike:

```typescript
@EventPattern('order.created')
handleOrderCreated(@Payload() data: OrderCreatedDto): Observable<void> {
  return from(this.processOrder(data));
}
```

- A `Promise<Observable>` (common when NestJS exception filters wrap errors) is awaited first, then subscribed.
- Plain values and Promises work as usual.
- An Observable that completes without emitting yields `undefined`.

## Consumer Self-Healing

**Q: What happens if a consumer's message iterator breaks (e.g., NATS restarts)?**

Every consumer (event, command, broadcast, ordered, schedule) runs a self-healing loop. When the iterator ends unexpectedly (stream deletion, server restart, network partition), the loop restarts it after `min(100ms × 2^failures, 30s)`: 200 ms after the first failure, then 400 ms, 800 ms, 1.6 s, up to 30 s. The counter resets once the consumer is live again.

Each failure emits `TransportEvent.Error`, and a recovery after failures emits `TransportEvent.ConsumerRecovered` with the attempt count. See [Lifecycle Hooks](/docs/guides/lifecycle-hooks).

A deleted durable consumer is recreated, with three exceptions:

- **A migration is running.** If `{stream}__migration_backup` exists, recovery waits with backoff until the backup is gone, so it cannot take workqueue messages that are being restored. See [Stream Migration](/docs/guides/stream-migration#to-consumers-on-other-pods-rolling-updates).
- **Another pod recreated it first.** Recovery uses the existing consumer as-is instead of issuing its own create or update.
- **The consumer is Manual.** It is never recreated: recovery waits for it to be [restored externally](/docs/guides/external-infrastructure#self-healing-for-manual-consumers).

Ordered consumers are ephemeral: the nats.js client recreates them itself, outside this recovery path.

## NATS Header Size Limits

**Q: Are there limits on custom headers?**

Headers count toward the message size. The transport reserves some names (`setHeader()` throws on them) and rejects every `Nats-*` header except the `Nats-Expected-*` optimistic concurrency headers; the others are reached through the builder methods. The full list is in the [Header Contract](/docs/reference/header-contract#reserved-you-cant-set-these).

## DeliverPolicy.All Workaround

**Q: Why does the ordered consumer not pass `DeliverPolicy.All` explicitly?**

Passing `DeliverPolicy.All` explicitly to an ordered consumer left `opt_start_seq` in its configuration and made `consume()` hang. This was observed in the `nats` package v2.29.x, and the workaround stays in place for `@nats-io/jetstream` v3.x. The transport omits `deliver_policy` when it is `All`, which is the SDK default anyway, so behavior is unchanged. Any other policy, such as `DeliverPolicy.New`, is passed through. See [Ordered Events, Deliver policies](/docs/patterns/ordered-events#deliver-policies).

## Nanosecond precision loss

JetStream timestamps are nanoseconds (`int64` in Go), but the JavaScript SDK holds them as `number` (float64). `Number.MAX_SAFE_INTEGER` is about 9×10^15 and current timestamps in nanoseconds are about 1.7×10^18, so **nanosecond values lose precision at the millisecond level**.

- `ctx.getTimestamp()` returns a `Date`, accurate to ±1 ms.
- `toNanos()` is exact for typical config values (seconds, minutes), but sub-millisecond precision is not guaranteed.
- `msg.info.timestampNanos` is already truncated by the SDK.

`BigInt` inside this library would not help, because the SDK converts to and from `number` at the boundary. For ordering and deduplication NATS uses stream sequence numbers, which are safe integers.
