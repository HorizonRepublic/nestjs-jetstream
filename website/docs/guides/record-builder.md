---
sidebar_position: 1
title: "Record Builder & Deduplication"
---

import Since from '@site/src/components/Since';

# Record Builder & Deduplication

`JetstreamRecordBuilder` is a fluent builder for attaching custom headers, per-request timeouts, and deduplication IDs to outbound messages. It follows the same record-builder pattern used by other NestJS transports (`RmqRecord`, `NatsRecord`).

## Basic usage

Build a record and pass it as the payload to `client.send()` or `client.emit()`:

```typescript
import { JetstreamRecordBuilder } from '@horizon-republic/nestjs-jetstream';

const record = new JetstreamRecordBuilder({ orderId: 42 })
  .setHeader('x-tenant', 'acme')
  .setTimeout(5000)
  .build();

// Fire-and-forget event
await lastValueFrom(this.client.emit('order.created', record));

// RPC request
const result = await lastValueFrom(this.client.send('get.order', record));
```

The builder is immutable after `.build()` — the returned `JetstreamRecord` is a frozen snapshot of the data, headers, timeout, and message ID at the time of construction.

## Custom headers

Use `setHeader()` to attach metadata that travels alongside the payload. Headers are available in handlers via [`RpcContext.getHeader()`](./handler-context.md).

```typescript
const record = new JetstreamRecordBuilder(data)
  .setHeader('x-tenant', 'acme')
  .setHeader('x-trace-id', traceId)
  .build();
```

For multiple headers at once, use `setHeaders()`:

```typescript
const record = new JetstreamRecordBuilder(data)
  .setHeaders({
    'x-tenant': 'acme',
    'x-trace-id': traceId,
    'x-request-source': 'api-gateway',
  })
  .build();
```

## Message ID & JetStream deduplication

<Since version="2.3.0" />

JetStream has built-in **server-side deduplication**. When a message is published with a message ID, the server remembers that ID for a configurable time window. If a second message with the same ID arrives within the window, it is silently dropped — no duplicate processing occurs.

### How the dedup window works

Each JetStream stream has a `duplicate_window` setting that controls how long the server remembers message IDs. The default window is **2 minutes** for event, broadcast, and ordered streams, and **30 seconds** for command (RPC) streams.

If you do **not** set a message ID, the transport generates a random UUID for every publish. This means no deduplication by default — each publish is treated as a unique message.

### Setting a deterministic message ID

To enable deduplication, provide a **deterministic** ID derived from your domain data:

```typescript
const record = new JetstreamRecordBuilder(orderData)
  .setMessageId(`order-created-${order.id}`)
  .build();

await lastValueFrom(this.client.emit('order.created', record));
```

Now if a network retry or application restart causes the same event to be published twice, the JetStream server drops the duplicate automatically.

:::tip Choose IDs carefully
Good message IDs are derived from business identifiers: `order-${orderId}`, `payment-${paymentId}-refund`, `user-${userId}-email-changed`. Avoid timestamps or random values — they defeat the purpose of deduplication.
:::

:::warning Window expiration
Deduplication only works within the `duplicate_window`. If your retry logic can span longer than the window, you need application-level idempotency checks in your handlers as well.
:::

## Per-request timeout override

The `setTimeout()` method overrides the global RPC timeout for a single request. This is useful for operations that are known to be slow:

```typescript
// This request gets 30 seconds instead of the global default
const record = new JetstreamRecordBuilder({ reportId: 'annual-2024' })
  .setTimeout(30_000)
  .build();

const report = await lastValueFrom(
  this.client.send('generate.report', record),
);
```

The timeout only applies to RPC (`client.send()`). For fire-and-forget events (`client.emit()`), timeout has no effect since there is no response to wait for.

## Reserved headers

The transport uses three headers internally for RPC correlation. These are **reserved** and cannot be set via the builder:

| Header | Purpose |
|---|---|
| `x-correlation-id` | Links an RPC request to its response |
| `x-reply-to` | Inbox subject for the RPC response |
| `x-error` | Marks error responses so the client can distinguish success from failure |

Attempting to set a reserved header throws an error at **build time**:

```typescript
// Throws: Header "x-correlation-id" is reserved by the JetStream transport
// and cannot be set manually.
new JetstreamRecordBuilder(data)
  .setHeader('x-correlation-id', 'my-id')
  .build();
```

:::note
The error is thrown on `setHeader()`, not on `build()`. This gives you immediate feedback at the call site.
:::

## Auto-set transport headers

In addition to reserved headers, the transport automatically sets two informational headers on every outbound message:

| Header | Value | Description |
|---|---|---|
| `x-subject` | NATS subject | The original subject the message was published to |
| `x-caller-name` | Service name | The internal name of the sending service |

These headers are read-only from the handler's perspective — you can access them via `ctx.getHeader('x-subject')` but cannot override them via the builder.

## API summary

| Method | Description |
|---|---|
| `new JetstreamRecordBuilder(data?)` | Create a builder, optionally with initial payload |
| `.setData(data)` | Set or replace the payload |
| `.setHeader(key, value)` | Add a single custom header |
| `.setHeaders(record)` | Add multiple headers from a key-value object |
| `.setMessageId(id)` | Set a deterministic message ID for deduplication |
| `.setTimeout(ms)` | Override the global RPC timeout for this request |
| `.build()` | Return an immutable `JetstreamRecord` |

## Next steps

- [Handler Context](./handler-context.md) — access headers and message metadata in your handlers
- [Custom Codec](./custom-codec.md) — control how payloads are serialized
- [Module Configuration](/docs/getting-started/module-configuration) — configure dedup windows via stream overrides
