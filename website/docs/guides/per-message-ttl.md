---
sidebar_position: 4
sidebar_label: "Message TTL"
title: "How to set per-message TTL: NestJS JetStream"
description: "Set individual NATS JetStream message expiration via the Nats-TTL header (NATS 2.11, ADR-43), independent of the stream's max_age."
schema:
  type: Article
  headline: "How to set per-message TTL on NATS JetStream messages"
  description: "Set individual message expiration via the Nats-TTL header (NATS 2.11, ADR-43)."
  datePublished: "2026-04-02"
  dateModified: "2026-10-23"
---

# How to set per-message TTL

> **Use when:** individual messages should expire on their own schedule instead of the stream's.
> **You get:** the `ttl()` builder method, the stream flag it needs, and how it interacts with `max_age`.

`ttl()` gives one message its own lifetime through the `Nats-TTL` header ([ADR-43](https://github.com/nats-io/nats-architecture-and-design/blob/main/adr/ADR-43.md)). Typical uses are short-lived values such as one-time codes, session tokens or temporary overrides that should not outlive their purpose in the stream.

It needs NATS 2.11 and `allow_msg_ttl: true` on the target stream. On an older server, `ttl()` and the flag throw a `JetstreamCapabilityError`, because such servers accept both and never expire anything.

## Enable it on the stream

```typescript
JetstreamModule.forRoot({
  name: 'sessions',
  servers: ['nats://localhost:4222'],
  events: {
    stream: { allow_msg_ttl: true },
  },
});
```

Turning the flag on is a regular stream update, without recreation or downtime. It can never be turned off again. Each stream opts in separately.

## Set a TTL

```typescript
import { JetstreamRecordBuilder, toNanos } from '@horizon-republic/nestjs-jetstream';
import { lastValueFrom } from 'rxjs';

const record = new JetstreamRecordBuilder({ token: 'abc123', userId: 42 })
  .ttl(toNanos(30, 'minutes'))
  .build();

await lastValueFrom(this.client.emit('session.token', record));
```

NATS removes the message 30 minutes after it was stored. A consumer that reads it before then handles it like any event and cannot tell it has a TTL.

## TTL and `max_age`

The shorter of the two wins. A 5-minute TTL in a stream with a 7-day `max_age` expires after 5 minutes; a TTL longer than `max_age` still expires at `max_age`. Messages without a TTL follow `max_age` as usual.

With [`scheduleAt()`](./scheduling), the TTL applies to the delivered message and counts from the moment the schedule fires.

## Limitations

- **Events only.** For RPC (`client.send()`) the transport logs a warning and ignores `ttl()`.
- **Positive, finite values.** `ttl()` throws on zero, a negative number or `Infinity`.

## See also

- [Record builder](/docs/guides/record-builder): the rest of the builder API
- [Default configs](/docs/reference/default-configs#enable-only-can-be-turned-on-but-never-off): `allow_msg_ttl` among the enable-only properties
