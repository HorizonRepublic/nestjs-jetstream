---
sidebar_position: 4
sidebar_label: "Per-Message TTL"
title: "Per-Message TTL — NATS JetStream Message Expiration"
description: "Individual NestJS NATS JetStream message expiration via the Nats-TTL header (NATS 2.11, ADR-43), independent of the stream's max_age."
schema:
  type: Article
  headline: "Per-Message TTL — NATS JetStream Message Expiration"
  description: "Individual NestJS NATS JetStream message expiration via the Nats-TTL header (NATS 2.11, ADR-43), independent of the stream's max_age."
  datePublished: "2026-04-02"
  dateModified: "2026-04-11"
---

import Since from '@site/src/components/Since';

# Per-Message TTL

<Since version="2.9.0" />

Individual message expiration via the `Nats-TTL` header ([ADR-43](https://github.com/nats-io/nats-architecture-and-design/blob/main/adr/ADR-43.md)). Each message can have its own lifetime, independent of the stream's `max_age`.

## Requirements

- **NATS Server >= 2.11**
- `allow_msg_ttl: true` on the stream

## Configuration

Enable per-message TTL on the event stream:

```typescript
JetstreamModule.forRoot({
  name: 'sessions',
  servers: ['nats://localhost:4222'],
  events: {
    stream: { allow_msg_ttl: true },
  },
});
```

This flag can be safely added to existing streams — NATS applies it as a regular update without recreation or downtime.

## Usage

Use `ttl()` on `JetstreamRecordBuilder` with nanoseconds (via `toNanos()`):

```typescript
import { JetstreamRecordBuilder, toNanos } from '@horizon-republic/nestjs-jetstream';
import { lastValueFrom } from 'rxjs';

const record = new JetstreamRecordBuilder({ token: 'abc123', userId: 42 })
  .ttl(toNanos(30, 'minutes'))
  .build();

await lastValueFrom(this.client.emit('session.token', record));
```

The consumer handles it like any normal event — no changes needed on the receiving side. After 30 minutes, NATS automatically removes the message from the stream.

## Use cases

| Scenario | TTL | Why |
|----------|-----|-----|
| Session tokens | 30 minutes | Auto-expire inactive sessions |
| OTP codes | 5 minutes | Security — short-lived by design |
| Cache entries | 1 hour | Stale cache auto-cleans |
| Feature flags | 24 hours | Temporary overrides that self-remove |
| Rate limit counters | 1 minute | Rolling window without cleanup jobs |

## How it works

1. `.ttl(toNanos(30, 'minutes'))` passes the TTL through to the NATS JetStream publish options
2. NATS sets the `Nats-TTL` header on the stored message (see [ADR-43](https://github.com/nats-io/nats-architecture-and-design/blob/main/adr/ADR-43.md))
3. After 30 minutes, NATS automatically removes the message from the stream
4. If a consumer processes the message before expiry, it works normally

## Important: `max_age` interaction

Per-message TTL works **independently** from stream `max_age`:

- A message with `ttl: "5m"` in a stream with `max_age: 7d` expires after 5 minutes
- A message without TTL in the same stream expires after 7 days (stream default)
- If `ttl` exceeds `max_age`, the message still expires at `max_age` (stream wins)

## Limitations

| Limitation | Details |
|-----------|---------|
| **Events only** | `ttl()` is ignored for RPC ([`client.send()`](/docs/patterns/rpc)); a warning is logged |
| **NATS >= 2.11** | `allow_msg_ttl` is not supported by older server versions |
| **Per-stream opt-in** | Each stream must have `allow_msg_ttl: true` explicitly |
| **No consumer-side awareness** | Consumers don't know if a message has TTL — they process it normally before expiry |

## See also

- [Record Builder & Deduplication](/docs/guides/record-builder) — full `JetstreamRecordBuilder` API including `.ttl()`, `.setMessageId()`, `.scheduleAt()`
- [Scheduling (Delayed Jobs)](/docs/guides/scheduling) — the sibling feature for one-shot delayed delivery
- [Default Configs](/docs/reference/default-configs#enable-only-can-be-turned-on-but-never-off) — `allow_msg_ttl` in the enable-only stream properties table
- [Module Configuration](/docs/getting-started/module-configuration) — where to set `events.stream.allow_msg_ttl`
