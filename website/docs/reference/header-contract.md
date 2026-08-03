---
sidebar_position: 5
sidebar_label: "Header Contract"
title: "Header Contract: NATS Message Headers Used by the Transport"
description: "Stable contract for NATS message headers the transport reads and writes: W3C Trace Context, JetStream metadata, and library-internal markers."
schema:
  type: Article
  headline: "Header Contract: NATS Message Headers Used by the Transport"
  description: "Stable contract for NATS message headers the transport reads and writes."
  datePublished: "2026-04-24"
  dateModified: "2026-08-03"
---

# Header Contract

> **Use when:** another language or service reads or writes these messages.
> **You get:** every header the transport touches, who sets it, and the stability guarantee.

The transport reads and writes the headers below and nothing else. Names are **stable across minor versions** and change only on major bumps, so a publisher in Go, Python or Rust interoperates with a NestJS service by honouring them.

## At a glance

| Header                 |   Read    |   Write   | Source            | What it does                                                    |
| ---------------------- | :-------: | :-------: | ----------------- | --------------------------------------------------------------- |
| `traceparent`          |     ✓     |     ✓     | W3C Trace Context | Links the consume span to the upstream producer span.           |
| `tracestate`           |     ✓     |     ✓     | W3C Trace Context | Vendor-specific trace state. Forwarded as-is.                   |
| `baggage`              |     ✓     |     ✓     | W3C Baggage       | App-level context propagation. Forwarded.                       |
| `Nats-Msg-Id`          |     ✓     |     ✓     | NATS standard     | Dedup key. Surfaces on consume spans as `messaging.message.id`. |
| `x-correlation-id`     |    RPC    |    RPC    | Library           | Identifies the matching RPC reply.                              |
| `x-reply-to`           |    RPC    |    RPC    | Library           | Inbox subject for the RPC reply.                                |
| `x-error`              | RPC reply | RPC reply | Library           | Marks the reply payload as an error envelope.                   |
| `x-subject`            |     -     |     ✓     | Library           | Original subject the message was published to.                  |
| `x-caller-name`        |     -     |     ✓     | Library           | Internal name of the sending service.                           |
| `x-dead-letter-reason` |     -     |    DLQ    | Library           | DLQ tracking: exhausted-retry reason.                           |
| `x-original-subject`   |     -     |    DLQ    | Library           | DLQ tracking: original target subject.                          |
| `x-original-stream`    |     -     |    DLQ    | Library           | DLQ tracking: original stream name.                             |
| `x-failed-at`          |     -     |    DLQ    | Library           | DLQ tracking: ISO 8601 failure timestamp.                       |
| `x-delivery-count`     |     -     |    DLQ    | Library           | DLQ tracking: delivery attempt counter.                         |

Header names are matched **case-insensitively** per the W3C Trace Context specification.

## Reserved (you can't set these)

Calling `JetstreamRecordBuilder.setHeader()` with any of these throws a reserved-header error: they are populated by the library at publish time:

- `x-correlation-id` · `x-reply-to` · `x-error`

The builder accepts `x-subject` and `x-caller-name`. The transport writes both before your custom headers are applied, so a value you set for either one **wins**. Set them only when you are deliberately relabelling a message; the consume span and `ctx.getCallerName()` read what arrives on the wire.

User-defined headers should use a distinct prefix or name (`x-tenant-id`, `x-request-id`, `application-foo`) and avoid the reserved names above.

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

The NestJS consumer picks up `traceparent` from the headers and creates a CONSUMER span as a child of the Go producer span. The trace appears as a single end-to-end flow in your APM.

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

Per the [W3C Trace Context specification](https://www.w3.org/TR/trace-context/), the version field is fixed at `00` (current) and the flags field's lowest bit indicates whether the trace is sampled. See the spec for the full grammar.

</details>

## Compatibility

- **NATS server:** `>= 2.11` (preserves W3C Trace Context headers across publish and consume per ADR-41).
- **`@nats-io/nats-core`:** inherited transitively via `@nats-io/jetstream` and `@nats-io/transport-node` (both pinned to `^3.3.1`). You do not install `nats-core` directly: the resolved version is whatever those two pull in.
- **External publishers:** any NATS client capable of attaching headers.

The library does not require a NestJS or TypeScript service on the other side of the wire. The header contract is the only coupling point.
