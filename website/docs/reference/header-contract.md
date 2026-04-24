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
  dateModified: "2026-04-24"
---

# Header Contract

The transport reads and writes a defined set of NATS message headers. This page is the canonical reference for external publishers (Go, Python, Rust, or any other language) that interoperate with services using the library.

The contract is **stable across minor versions**. Header names will not change without a major version bump.

## Headers the transport reads

| Header             | Direction            | Source             | Purpose                                                |
|--------------------|----------------------|--------------------|--------------------------------------------------------|
| `traceparent`      | Inbound              | W3C Trace Context  | Parent span id used to link the consume span to the upstream producer. Read on every incoming message. |
| `tracestate`       | Inbound              | W3C Trace Context  | Vendor-specific trace state. Forwarded as-is.          |
| `baggage`          | Inbound              | W3C Baggage        | Application-level context propagation. Forwarded.      |
| `Nats-Msg-Id`      | Inbound              | NATS standard      | Message-id deduplication. Read for the `messaging.message.id` span attribute. |
| `x-correlation-id` | Inbound (RPC)        | Library-internal   | Required on RPC requests; identifies the response.     |
| `x-reply-to`       | Inbound (RPC)        | Library-internal   | Required on RPC requests; specifies the reply subject. |
| `x-error`          | Inbound (RPC reply)  | Library-internal   | When `true`, marks the reply payload as an error envelope. |

## Headers the transport writes

| Header             | Direction             | Destination        | Purpose                                              |
|--------------------|-----------------------|--------------------|------------------------------------------------------|
| `traceparent`      | Outbound              | W3C Trace Context  | Injected into every published message so downstream consumers continue the trace. |
| `tracestate`       | Outbound              | W3C Trace Context  | Forwarded when present in active context.            |
| `baggage`          | Outbound              | W3C Baggage        | Forwarded when present in active context.            |
| `Nats-Msg-Id`      | Outbound              | NATS standard      | Set when the user supplies a message id via `JetstreamRecordBuilder.setMessageId()`. |
| `x-correlation-id` | Outbound (RPC)        | Library-internal   | Generated per RPC request.                           |
| `x-reply-to`       | Outbound (RPC)        | Library-internal   | Inbox subject for the response.                      |
| `x-error`          | Outbound (RPC reply)  | Library-internal   | Set to `true` when the handler threw or the reply represents an error. |
| `x-subject`        | Outbound              | Library-internal   | Original subject the message was published to.       |
| `x-caller-name`    | Outbound              | Library-internal   | Internal name of the service that sent the message.  |

Header names are matched **case-insensitively** per the W3C Trace Context specification.

## Reserved header names

The transport reserves specific header names for internal use. Names are matched case-insensitively.

**Rejected at `JetstreamRecordBuilder.setHeader()` (`RESERVED_HEADERS`):**

Setting any of these via the builder throws `Reserved header cannot be overridden`. They are populated by the library at publish time.

- `x-correlation-id` — RPC request identifier
- `x-reply-to` — RPC response inbox subject
- `x-error` — RPC error reply marker

**Silently overwritten by the transport at publish time:**

Builder accepts values for these, but the value is replaced by the transport's own during `publish` / `send`, so supplying them has no effect.

- `x-subject` — original subject (transport pre-routing metadata)
- `x-caller-name` — internal service name of the publisher

**Dead-letter metadata (written when a message is republished to the DLQ stream):**

- `x-dead-letter-reason`, `x-original-subject`, `x-original-stream`, `x-failed-at`, `x-delivery-count`

**NATS server-level (`Nats-*` prefix):**

- Managed by the NATS server itself (`Nats-Msg-Id`, `Nats-TTL`, `Nats-Schedule`, …). Do not override.

User-defined headers should use a distinct prefix or name (e.g. `x-tenant-id`, `x-request-id`, `application-foo`) and avoid the reserved names above.

## Cross-language examples

### Publishing from Go (with OpenTelemetry)

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

The NestJS consumer will pick up `traceparent` from the headers and create a CONSUMER span as a child of the Go producer span. The trace appears as a single end-to-end flow in your APM.

### Publishing from Python (with OpenTelemetry)

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

### Reading the trace context manually

If you cannot use OpenTelemetry on the consumer side, you can still inspect the W3C trace headers yourself. The `traceparent` header has the form:

```text
00-<32-hex-trace-id>-<16-hex-parent-span-id>-<2-hex-flags>
```

Example: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`.

Per the [W3C Trace Context specification](https://www.w3.org/TR/trace-context/), the version field is fixed at `00` (current) and the flags field's lowest bit indicates whether the trace is sampled. See the spec for the full grammar.

## Compatibility

- **NATS server:** `>= 2.11` (preserves W3C Trace Context headers across publish and consume per ADR-41).
- **`@nats-io/nats-core`:** inherited transitively via `@nats-io/jetstream` and `@nats-io/transport-node` (both pinned to `^3.3.1`). You do not install `nats-core` directly — the resolved version is whatever those two pull in.
- **External publishers:** any NATS client capable of attaching headers.

The library does **not** require a NestJS or TypeScript service on the other side of the wire. The header contract is the only coupling point.
