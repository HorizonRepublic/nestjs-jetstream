---
sidebar_position: 5
sidebar_label: "Header Contract"
title: "Header Contract — NATS Message Headers Used by the Transport"
description: "Stable contract for NATS message headers the transport reads and writes — W3C Trace Context, JetStream metadata, and library-internal markers."
schema:
  type: Article
  headline: "Header Contract — NATS Message Headers Used by the Transport"
  description: "Stable contract for NATS message headers the transport reads and writes."
  datePublished: "2026-04-24"
  dateModified: "2026-04-27"
---

# Header Contract

Every NATS message header the transport touches — in one place. The contract is **stable across minor versions**; header names change only on major bumps. External publishers (Go, Python, Rust, …) only need to honour this page to interoperate with NestJS services using the library.

## At a glance

| Header | Read | Write | Source | What it does |
|---|:---:|:---:|---|---|
| `traceparent` | ✓ | ✓ | W3C Trace Context | Links the consume span to the upstream producer span. |
| `tracestate` | ✓ | ✓ | W3C Trace Context | Vendor-specific trace state. Forwarded as-is. |
| `baggage` | ✓ | ✓ | W3C Baggage | App-level context propagation. Forwarded. |
| `Nats-Msg-Id` | ✓ | ✓ | NATS standard | Dedup key. Surfaces on consume spans as `messaging.message.id`. |
| `x-correlation-id` | RPC | RPC | Library | Identifies the matching RPC reply. |
| `x-reply-to` | RPC | RPC | Library | Inbox subject for the RPC reply. |
| `x-error` | RPC reply | RPC reply | Library | Marks the reply payload as an error envelope. |
| `x-subject` | — | ✓ | Library | Original subject the message was published to. |
| `x-caller-name` | — | ✓ | Library | Internal name of the sending service. |
| `x-dead-letter-reason` | — | DLQ | Library | DLQ tracking — exhausted-retry reason. |
| `x-original-subject` | — | DLQ | Library | DLQ tracking — original target subject. |
| `x-original-stream` | — | DLQ | Library | DLQ tracking — original stream name. |
| `x-failed-at` | — | DLQ | Library | DLQ tracking — ISO 8601 failure timestamp. |
| `x-delivery-count` | — | DLQ | Library | DLQ tracking — delivery attempt counter. |

Header names are matched **case-insensitively** per the W3C Trace Context specification.

## Reserved (you can't set these)

Calling `JetstreamRecordBuilder.setHeader()` with any of these throws a reserved-header error — they are populated by the library at publish time:

- `x-correlation-id` · `x-reply-to` · `x-error`

The builder accepts values for these next two, but they're **silently overwritten** at publish time:

- `x-subject` · `x-caller-name`

User-defined headers should use a distinct prefix or name (`x-tenant-id`, `x-request-id`, `application-foo`) and avoid the reserved names above.

## NATS server-interpreted (`Nats-*` prefix)

These are interpreted by the NATS server itself, not by this library:

- **`Nats-Msg-Id`** — publisher-supplied deduplication key. Set via `JetstreamRecordBuilder.setMessageId()` (from this library) or directly on the headers map (external publishers). Do not set it both ways on the same publish.
- **`Nats-TTL`, `Nats-Schedule`, `Nats-Expected-*`, `Nats-Rollup`, …** — set them per the [NATS docs](https://docs.nats.io/) when you need their semantics; otherwise leave them alone.

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
- **`@nats-io/nats-core`:** inherited transitively via `@nats-io/jetstream` and `@nats-io/transport-node` (both pinned to `^3.3.1`). You do not install `nats-core` directly — the resolved version is whatever those two pull in.
- **External publishers:** any NATS client capable of attaching headers.

The library does **not** require a NestJS or TypeScript service on the other side of the wire. The header contract is the only coupling point.
