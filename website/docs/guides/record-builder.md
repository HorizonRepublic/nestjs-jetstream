---
sidebar_position: 1
sidebar_label: "Record Builder"
title: "JetstreamRecordBuilder: Headers, Message IDs & Deduplication"
description: "Build NestJS NATS messages with custom headers, deterministic message IDs for publish-side deduplication, and per-request RPC timeouts."
schema:
  type: Article
  headline: "JetstreamRecordBuilder: Headers, Message IDs & Deduplication"
  description: "Build NestJS NATS messages with custom headers, deterministic message IDs for publish-side deduplication, and per-request RPC timeouts."
  datePublished: "2026-03-21"
  dateModified: "2026-10-29"
---

# Record Builder & Deduplication

> **Use when:** a message needs custom headers, its own timeout or a deduplication ID.
> **You get:** `JetstreamRecordBuilder`, the server-side dedup window, and which headers you cannot set.

`JetstreamRecordBuilder` follows the record-builder pattern of the other NestJS transports (`RmqRecord`, `NatsRecord`).

## Basic usage

Build a record and pass it as the payload to `client.send()` or `client.emit()`:

```typescript
import { JetstreamRecordBuilder } from '@horizon-republic/nestjs-jetstream';

const record = new JetstreamRecordBuilder({ orderId: 42 })
  .setHeader('x-tenant', 'acme')
  .build();

await lastValueFrom(this.client.emit('order.created', record));
const result = await lastValueFrom(this.client.send('get.order', record));
```

`build()` returns a `JetstreamRecord` snapshot: later calls on the builder do not change it.

## Custom headers

`setHeader()` adds one header, `setHeaders()` adds several. Handlers read them with [`ctx.getHeader()`](/docs/guides/handler-context).

```typescript
const record = new JetstreamRecordBuilder(data)
  .setHeader('x-trace-id', traceId)
  .setHeaders({ 'x-tenant': 'acme', 'x-request-source': 'api-gateway' })
  .build();
```

## Message ID & JetStream deduplication

When a message carries a message ID, the JetStream server remembers it for the stream's `duplicate_window` and drops a second publish with the same ID inside that window. The window is **2 minutes** on every stream except the command (RPC) stream, where it is **30 seconds** ([defaults](/docs/reference/default-configs)).

Without `setMessageId()`, the transport generates a unique ID (a NUID) for every publish, so nothing is deduplicated. Pass a **deterministic** ID derived from domain data to turn deduplication on:

```typescript
const record = new JetstreamRecordBuilder(orderData)
  .setMessageId(`order-created-${order.id}`)
  .build();

await lastValueFrom(this.client.emit('order.created', record));
```

A network retry or a restart that publishes the same event again is now dropped by the server. The client logs a `Duplicate event publish detected` warning when that happens.

:::tip Choose IDs carefully
Derive IDs from business identifiers: `order-${orderId}`, `payment-${paymentId}-refund`, `user-${userId}-email-changed`. Timestamps or random values defeat deduplication.
:::

:::warning Window expiration
Deduplication only works within the `duplicate_window`. If your retries can span longer than the window, add application-level idempotency checks in your handlers.
:::

## Per-request timeout override

`setTimeout()` overrides the global RPC timeout for one request:

```typescript
const record = new JetstreamRecordBuilder({ reportId: 'annual-2024' })
  .setTimeout(30_000)
  .build();

const report = await lastValueFrom(this.client.send('generate.report', record));
```

It applies to `client.send()` only. `client.emit()` waits for no response, so the value has no effect there.

## Scheduled delivery

`scheduleAt(date)` holds an event on the server and delivers it at `date`. It works with `client.emit()` only and needs a newer NATS server; see [Scheduling (Delayed Jobs)](/docs/guides/scheduling).

## Headers the transport sets itself

`setHeader()` throws for the headers the transport reserves (`x-correlation-id`, `x-reply-to`, `x-error`, the schedule headers `x-schedule-hash` and `x-schedule-pattern`, and `x-redrive-count`) and for every header starting with `nats-`, whatever the casing. The error is thrown at the `setHeader()` call, not at `build()`. Reach the `Nats-*` headers through `setMessageId()`, `ttl()` and `scheduleAt()`. [Header Contract](/docs/reference/header-contract) lists every header the transport reads and writes, including `x-subject` and `x-caller-name`, which you can overwrite.

## API summary

```typescript
class JetstreamRecordBuilder<T = unknown> {
  /** Create a builder, optionally with an initial payload. */
  constructor(data?: T);

  /** Set or replace the payload. */
  setData(data: T): this;

  /** Add a single custom header. Reserved headers throw. */
  setHeader(key: string, value: string): this;

  /** Add multiple headers from a key-value object. */
  setHeaders(record: Record<string, string>): this;

  /** Set a deterministic message ID for JetStream-level deduplication. */
  setMessageId(id: string): this;

  /** Override the global RPC timeout for this single request. */
  setTimeout(ms: number): this;

  /** Schedule one-shot delayed delivery. Events only. @since 2.8.0 */
  scheduleAt(date: Date): this;

  /** Set per-message TTL in nanoseconds via the `Nats-TTL` header. Events only. @since 2.9.0 */
  ttl(nanos: number): this;

  /** Return an immutable JetstreamRecord. */
  build(): JetstreamRecord<T>;
}
```

The exported `RESERVED_HEADERS` set lets custom tooling check a key before calling `setHeader()`. It does not cover the `nats-` prefix, so a sanitizer needs that check alongside it:

```typescript
import { RESERVED_HEADERS } from '@horizon-republic/nestjs-jetstream';

if (RESERVED_HEADERS.has(key.toLowerCase()) || key.toLowerCase().startsWith('nats-')) {
  throw new Error(`${key} is reserved by the transport`);
}
```

## Next steps

- [Per-Message TTL](/docs/guides/per-message-ttl): `ttl()`
- [Scheduling (Delayed Jobs)](/docs/guides/scheduling): `scheduleAt()`
- [Handler Context](/docs/guides/handler-context): read headers and metadata in handlers
- [Custom Codec](/docs/guides/custom-codec): control how payloads are serialized
- [Module Configuration](/docs/reference/module-configuration): change `duplicate_window` through stream overrides
