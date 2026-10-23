---
sidebar_position: 5
sidebar_label: "Header Contract"
title: "Header Contract: NATS Message Headers Used by the Transport"
description: "Stable contract for the NATS message headers this transport reads and writes, from W3C Trace Context to JetStream metadata and library-internal markers."
schema:
  type: Article
  headline: "Header Contract: NATS Message Headers Used by the Transport"
  description: "Stable contract for NATS message headers the transport reads and writes."
  datePublished: "2026-04-24"
  dateModified: "2026-10-23"
---

# Header Contract

> **Use when:** another language or service reads or writes these messages.
> **You get:** every header the transport touches, who sets it, and the stability guarantee.

The transport reads and writes the headers below and nothing else. Names are **stable across minor versions** and change only on major bumps, so a publisher in Go, Python or Rust interoperates with a NestJS service by honouring them.

## At a glance

| Header                 |   Read    |   Write   | Source            | What it does                                                                |
| ---------------------- | :-------: | :-------: | ----------------- | --------------------------------------------------------------------------- |
| `traceparent`          |     ✓     |     ✓     | W3C Trace Context | Links the consume span to the upstream producer span.                       |
| `tracestate`           |     ✓     |     ✓     | W3C Trace Context | Vendor-specific trace state. Forwarded as-is.                               |
| `baggage`              |     ✓     |     ✓     | W3C Baggage       | App-level context propagation. Forwarded.                                   |
| `Nats-Msg-Id`          |     ✓     |     ✓     | NATS standard     | Dedup key. Surfaces on consume spans as `messaging.message.id`.             |
| `x-correlation-id`     |    RPC    |    RPC    | Library           | Identifies the matching RPC reply.                                          |
| `x-reply-to`           |    RPC    |    RPC    | Library           | Inbox subject for the RPC reply.                                            |
| `x-error`              | RPC reply | RPC reply | Library           | Marks the reply payload as an error envelope.                               |
| `x-subject`            |     -     |     ✓     | Library           | Original subject the message was published to.                              |
| `x-caller-name`        |     -     |     ✓     | Library           | Internal name of the sending service.                                       |
| `x-dead-letter-reason` |     -     |    DLQ    | Library           | DLQ tracking: exhausted-retry reason.                                       |
| `x-original-subject`   |     -     |    DLQ    | Library           | DLQ tracking: original target subject.                                      |
| `x-original-stream`    |     -     |    DLQ    | Library           | DLQ tracking: original stream name.                                         |
| `x-failed-at`          |     -     |    DLQ    | Library           | DLQ tracking: ISO 8601 failure timestamp.                                   |
| `x-delivery-count`     |     -     |    DLQ    | Library           | DLQ tracking: delivery attempt counter.                                     |
| `x-schedule-hash`      |  Holder   |  Holder   | Library           | Fingerprint of a recurring schedule's definition. Skips unchanged rewrites. |
| `x-schedule-pattern`   |  Holder   |  Holder   | Library           | Handler pattern a recurring schedule's ticks go to.                         |
| `Nats-Scheduler`       |   Tick    |     -     | NATS server       | Subject of the holder that fired the tick.                                  |
| `Nats-Schedule-Next`   |     -     |     -     | NATS server       | Next fire time of the schedule, set on each tick.                           |

Header names are matched **case-insensitively** per the W3C Trace Context specification.

A schedule holder is the message on the `_cron.` subject that defines a [recurring schedule](/docs/guides/recurring-schedules). The server copies the holder's headers, `x-schedule-*` included, into every tick it fires, so a tick handler sees them through `ctx.getHeader()` alongside `Nats-Scheduler` and `Nats-Schedule-Next`.

## Reserved (you can't set these)

`JetstreamRecordBuilder.setHeader()` throws on these, because the library populates them:

- `x-correlation-id` · `x-reply-to` · `x-error` · `x-schedule-hash` · `x-schedule-pattern`

The builder accepts `x-subject` and `x-caller-name`. The transport writes both before your custom headers are applied, so a value you set for either one **wins**. Set them only when you are deliberately relabelling a message, because the consume span and `ctx.getCallerName()` read what arrives on the wire.

Give your own headers distinct names (`x-tenant-id`, `x-request-id`).

## NATS server-interpreted (`Nats-*` prefix)

`setHeader()` rejects **every** header starting with `nats-`, whatever the casing. These drive server-side behaviour: a stray `Nats-Rollup` purges every pending message on the subject. Reach them through the builder methods instead:

| Header          | Builder method     | Guide                                           |
| --------------- | ------------------ | ----------------------------------------------- |
| `Nats-Msg-Id`   | `setMessageId(id)` | Deduplication within `duplicate_window`         |
| `Nats-TTL`      | `ttl(nanos)`       | [Per-message TTL](/docs/guides/per-message-ttl) |
| `Nats-Schedule` | `scheduleAt(date)` | [Scheduling](/docs/guides/scheduling)           |

External publishers in other languages set these directly on the headers map, as the NATS docs describe. Do not set `Nats-Msg-Id` both ways on the same publish.

## Cross-language examples

<details>
<summary>Publishing from Go (with OpenTelemetry)</summary>

```go
import (
  "go.opentelemetry.io/otel"
  "go.opentelemetry.io/otel/propagation"
  "github.com/nats-io/nats.go"
)

ctx, span := tracer.Start(ctx, "create-order")
defer span.End()

headers := nats.Header{}
otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(headers))

js.PublishMsg(&nats.Msg{
  Subject: "orders__microservice.ev.orders.created",
  Data:    payload,
  Header:  headers,
})
```

The NestJS consumer reads `traceparent` and starts its CONSUMER span as a child of the Go producer span, so the trace shows as one flow in your APM.

</details>

<details>
<summary>Publishing from Python (with OpenTelemetry)</summary>

```python
from opentelemetry import propagate
from nats.aio.msg import Msg

headers = {}
propagate.inject(headers)

await js.publish(
    subject="orders__microservice.ev.orders.created",
    payload=payload,
    headers=headers,
)
```

</details>

<details>
<summary>Reading <code>traceparent</code> manually (no OTel)</summary>

The header has the form:

```text
00-<32-hex-trace-id>-<16-hex-parent-span-id>-<2-hex-flags>
```

Example: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`.

The version is `00`, and the lowest bit of the flags marks the trace as sampled. The [W3C Trace Context specification](https://www.w3.org/TR/trace-context/) has the full grammar.

</details>

## Compatibility

- **NATS server:** headers work on every supported version. `Nats-TTL` and `Nats-Schedule` need newer servers, see [NATS server versions](/docs/getting-started/installation#nats-server-versions).
- **External publishers:** any NATS client that can attach headers. The other side of the wire does not need to be NestJS or TypeScript: these headers are the only coupling.
