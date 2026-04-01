---
sidebar_position: 3
title: Edge Cases & FAQ
schema:
  type: Article
  headline: Edge Cases & FAQ
  description: "Common questions and non-obvious behaviors of the transport."
  datePublished: "2026-03-21"
  dateModified: "2026-03-30"
---

# Edge Cases & FAQ

Answers to common questions and non-obvious behaviors of the transport.

## Fire-and-Forget Messaging

**Q: How do I send a message without waiting for a response?**

This transport does not implement fire-and-forget on Core NATS (non-JetStream) subjects. If you need fire-and-forget over raw NATS `publish()`, use the standard NestJS NATS transport (`@nestjs/microservices` `ClientProxy`) alongside this library. Both transports can share the same NATS cluster.

For JetStream-based fire-and-forget, use `client.emit()` — this publishes an event to the event stream without expecting a response:

```typescript
this.client.emit('order.created', { orderId: '123' });
```

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

The broadcast stream is named `broadcast-stream` (no service prefix) because it is **shared across all services** in the cluster. Every service that registers `@EventPattern('broadcast:...')` handlers creates its own durable consumer on this same stream.

This means:
- Any service can publish to `broadcast.{pattern}`
- Every service with a matching handler receives its own copy of the message
- Each service's consumer tracks delivery independently (broadcast `nak` only affects that service's consumer)

See [Broadcast Events](/docs/patterns/broadcast) for usage details.

## Connection Failure Behavior

**Q: What happens if NATS is unreachable at startup?**

The transport **throws immediately** on startup if the initial connection fails. This is intentional — your NestJS application will fail to bootstrap, which lets orchestrators (Kubernetes, Docker Compose) detect and restart the service.

**After a successful initial connection**, the nats.js client handles automatic reconnection transparently. The transport monitors connection status events and emits lifecycle hooks (`Disconnect`, `Reconnect`) so your application can react. See [Lifecycle Hooks](/docs/guides/lifecycle-hooks) for details.

```typescript
// Connection refused at startup → throws, app fails to start
// Connection lost after startup → auto-reconnect with nats.js built-in logic
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

## NATS Header Size Limits

**Q: Are there limits on custom headers?**

NATS imposes a total header size limit (default 4 KB per message in most server configurations). The transport uses several [reserved headers](/docs/reference/api/enumerations/JetstreamHeader) (`x-correlation-id`, `x-reply-to`, `x-subject`, `x-caller-name`, `x-error`) that count toward this limit.

When using `JetstreamRecordBuilder.setHeader()`, keep in mind:
- Reserved headers (`x-correlation-id`, `x-reply-to`, `x-error`) cannot be overwritten
- Custom headers are additive — they are included alongside transport-managed headers
- If the total header size exceeds the NATS server limit, the publish will fail

See [Record Builder](/docs/guides/record-builder) for custom header usage.

## nats.js DeliverPolicy.All Workaround

**Q: Why does the ordered consumer not pass `DeliverPolicy.All` explicitly?**

There is a known issue in nats.js (v2.29.x) where explicitly passing `DeliverPolicy.All` to an ordered consumer leaves `opt_start_seq` in the consumer configuration, which causes `consume()` to hang indefinitely.

The transport works around this by **omitting** the `deliver_policy` field when it would be `DeliverPolicy.All` (the default). Since nats.js uses `All` as its internal default anyway, the behavior is identical — but the workaround avoids the hanging bug.

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

NATS JetStream uses nanosecond timestamps internally (`int64` in Go), but the nats.js SDK represents them as JavaScript `number` (IEEE 754 float64). Since `Number.MAX_SAFE_INTEGER` is ~9×10¹⁵ and current timestamps in nanos are ~1.7×10¹⁸, **arithmetic on nanosecond values loses ±1ms precision**.

This affects:
- `ctx.getTimestamp()` — returns `Date` (millisecond precision), accurate to ±1ms
- `toNanos()` helper — output is accurate for typical config values (seconds, minutes), but sub-millisecond precision is not guaranteed
- `msg.info.timestampNanos` — raw value from nats.js, already truncated before reaching this library

This is a fundamental limitation of the nats.js SDK, not this library. Using `BigInt` internally would not help — nats.js converts to/from `number` at the SDK boundary. For ordering and deduplication, NATS uses stream sequence numbers (integers, always safe) rather than timestamps.
