---
sidebar_position: 3
sidebar_label: "Edge Cases & FAQ"
title: "Edge Cases & FAQ — NestJS JetStream Transport"
description: "NestJS JetStream transport FAQ: publisher-only mode, consumer self-healing, NATS header limits, fire-and-forget messaging, and DeliverPolicy edge cases."
schema:
  type: Article
  headline: "Edge Cases & FAQ — NestJS JetStream Transport"
  description: "NestJS JetStream transport FAQ: publisher-only mode, consumer self-healing, NATS header limits, fire-and-forget messaging, and DeliverPolicy edge cases."
  datePublished: "2026-03-21"
  dateModified: "2026-04-11"
---

# Edge Cases & FAQ

Answers to common questions and non-obvious behaviors of the transport.

## Fire-and-Forget Messaging

**Q: How do I send a message without waiting for a response?**

Use `client.emit()`. This publishes an event to the event stream (JetStream-backed, so it is durable) and returns immediately without waiting for a handler:

```typescript
await lastValueFrom(this.client.emit('order.created', { orderId: '123' }));
```

If you specifically need non-durable Core NATS `publish()` (truly ephemeral pub/sub), use the standard `@nestjs/microservices` NATS transport alongside this library — both can share the same NATS cluster.

## Publisher-Only Mode

**Q: My API gateway only publishes events but never handles them. Do I need consumers?**

Set `consumer: false` in your `forRoot()` options. The transport will skip creating streams and consumers on the server side, and only initialize the client for publishing:

```typescript
JetstreamModule.forRoot({
  name: 'api-gateway',
  servers: ['nats://localhost:4222'],
  consumer: false, // no streams, no consumers, publish-only
});
```

This is ideal for API gateways and services that act purely as event producers.

## Broadcast Stream is Shared

**Q: Why does the broadcast stream name have no service prefix?**

The broadcast stream is named `broadcast-stream` (no service prefix) because it is **shared across all services** in the cluster. Every service that registers `@EventPattern('...', { broadcast: true })` handlers creates its own durable consumer on this same stream.

This means:
- Any service can publish to `broadcast.{pattern}`
- Every service with a matching handler receives its own copy of the message
- Each service's consumer tracks delivery independently (broadcast `nak` only affects that service's consumer)

See [Broadcast Events](/docs/patterns/broadcast) for usage details.

## Connection Failure Behavior

**Q: What happens if NATS is unreachable at startup?**

The transport **throws immediately** on startup if the initial connection fails. This is intentional — your NestJS application will fail to bootstrap, which lets orchestrators (Kubernetes, Docker Compose) detect and restart the service.

**After a successful initial connection**, the NATS client handles automatic reconnection transparently. The transport monitors connection status events and emits lifecycle hooks (`Disconnect`, `Reconnect`) so your application can react. See [Lifecycle Hooks](/docs/guides/lifecycle-hooks) for details.

```typescript
// Connection refused at startup → throws, app fails to start
// Connection lost after startup → auto-reconnect with NATS client built-in logic
```

## Observable Return Values in Handlers

**Q: What happens if my handler returns an Observable?**

The transport subscribes to the Observable and uses the **first emitted value** as the handler result. This applies to both event handlers and RPC handlers:

```typescript
@EventPattern('order.created')
handleOrderCreated(@Payload() data: OrderCreatedDto): Observable<void> {
  return from(this.processOrder(data));
}
```

Specifically:
- If the handler returns an `Observable`, the transport subscribes and resolves with the first `next` emission
- If the handler returns a `Promise<Observable>` (common when NestJS exception filters wrap errors), the Promise is awaited first, then the Observable is subscribed
- Plain values and Promises work as expected
- If the Observable completes without emitting, the result is `undefined`

## Consumer Self-Healing

**Q: What happens if a consumer's message iterator breaks (e.g., NATS restarts)?**

Each consumer runs a self-healing loop with **exponential backoff**. When the pull-based message iterator ends unexpectedly (stream deletion, NATS restart, network partition), the consumer automatically re-establishes:

1. First retry: **100ms** delay
2. Each subsequent failure doubles the delay: 200ms, 400ms, 800ms, ...
3. Maximum delay is capped at **30 seconds**
4. After a successful consumption cycle, the failure counter resets to zero

The backoff formula is: `min(100ms * 2^failures, 30,000ms)`

This applies to all consumer types: event, command, broadcast, and ordered. The transport emits a `TransportEvent.Error` hook on each failure so you can monitor consumer health. See [Lifecycle Hooks](/docs/guides/lifecycle-hooks).

**Consumer auto-recreation:** If a consumer is deleted, the transport automatically recreates it and resumes consumption. Common deletion scenarios include:

- Manual deletion via NATS CLI or admin tools
- Stream recreation during [migration](/docs/guides/stream-migration)
- NATS cluster state loss

The recovery is **migration-aware**: if a migration backup stream exists (another pod is mid-migration), the consumer is NOT recreated. Instead, self-healing waits with exponential backoff until migration completes and the backup is cleaned up. This prevents consumers from interfering with message restoration on workqueue streams.

During rolling updates, recovery never overwrites a newer pod's consumer configuration — if the consumer already exists (another pod recreated it), it is used as-is without config changes.

Ordered consumers are excluded from auto-recreation — they are ephemeral and managed internally by the nats.js client.

## NATS Header Size Limits

**Q: Are there limits on custom headers?**

NATS imposes a total header size limit (default 4 KB per message in most server configurations). The transport uses five [transport-managed headers](/docs/reference/api/enumerations/JetstreamHeader) that count toward this limit:

- **Reserved** — `x-correlation-id`, `x-reply-to`, `x-error`. Setting these via `JetstreamRecordBuilder.setHeader()` throws immediately at the call site.
- **Auto-set** — `x-subject`, `x-caller-name`. The transport populates these on every outbound message; any value you pass via the builder is silently replaced at publish time.

When using `JetstreamRecordBuilder.setHeader()`, keep in mind:
- None of the five transport-managed headers above can be overwritten from user code
- Custom headers are additive — they are included alongside transport-managed headers
- If the total header size exceeds the NATS server limit, the publish will fail

See [Record Builder](/docs/guides/record-builder) for custom header usage.

## DeliverPolicy.All Workaround

**Q: Why does the ordered consumer not pass `DeliverPolicy.All` explicitly?**

There is a known issue in the NATS JavaScript SDK where explicitly passing `DeliverPolicy.All` to an ordered consumer leaves `opt_start_seq` in the consumer configuration, which causes `consume()` to hang indefinitely. This was originally observed in the `nats` package v2.29.x and the workaround is retained for safety in `@nats-io/jetstream` v3.x.

The transport works around this by **omitting** the `deliver_policy` field when it would be `DeliverPolicy.All` (the default). Since the SDK uses `All` as its internal default anyway, the behavior is identical — but the workaround avoids the hanging bug.

If you configure a custom `deliverPolicy` on the ordered consumer (e.g., `DeliverPolicy.Last` or `DeliverPolicy.New`), it will be passed through explicitly:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  ordered: {
    deliverPolicy: DeliverPolicy.New, // this gets passed through
  },
});
```

See [Ordered Events](/docs/patterns/ordered-events) for the full ordered consumer configuration.

## Nanosecond precision loss

NATS JetStream uses nanosecond timestamps internally (`int64` in Go), but the `@nats-io/transport-node` SDK represents them as JavaScript `number` (IEEE 754 float64). Since `Number.MAX_SAFE_INTEGER` is ~9x10^15 and current timestamps in nanos are ~1.7x10^18, **arithmetic on nanosecond values loses +/-1ms precision**.

This affects:
- `ctx.getTimestamp()` — returns `Date` (millisecond precision), accurate to +/-1ms
- `toNanos()` helper — output is accurate for typical config values (seconds, minutes), but sub-millisecond precision is not guaranteed
- `msg.info.timestampNanos` — raw value from the SDK, already truncated before reaching this library

This is a fundamental limitation of the NATS JavaScript SDK, not this library. Using `BigInt` internally would not help — the SDK converts to/from `number` at the boundary. For ordering and deduplication, NATS uses stream sequence numbers (integers, always safe) rather than timestamps.
