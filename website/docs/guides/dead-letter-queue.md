---
sidebar_position: 2
sidebar_label: "Dead Letter Queue"
title: "How to configure a Dead Letter Queue: NestJS JetStream"
description: "Capture NestJS NATS JetStream messages that exhaust all delivery attempts: via a built-in DLQ stream with tracking headers or an onDeadLetter callback."
schema:
  type: Article
  headline: "How to configure a Dead Letter Queue"
  description: "Capture NestJS NATS JetStream messages that exhaust all delivery attempts via a DLQ stream or onDeadLetter callback."
  datePublished: "2026-03-21"
  dateModified: "2026-10-23"
---

# How to configure a Dead Letter Queue

> **Use when:** a message has failed every delivery attempt and you need it kept instead of dropped.
> **You get:** the built-in DLQ stream, the `onDeadLetter` callback, and the fallback chain between them.

A message that fails every delivery attempt and reaches `max_deliver` (default **3**) becomes a dead letter. These two mechanisms capture it, and they compose:

| Mechanism               | Added  | Role                                                                           |
| ----------------------- | ------ | ------------------------------------------------------------------------------ |
| `dlq: { stream }`       | v2.9.0 | Republishes to a dedicated JetStream stream with tracking headers. Start here. |
| `onDeadLetter` callback | v2.2.0 | Full context for custom persistence: database, S3, another queue.              |

Two more cases become dead letters immediately, whatever the delivery count, because redelivery cannot fix them:

- **No registered handler** for the subject, such as a handler renamed mid-deploy while producers still publish the old pattern. A [schedule tick](/docs/guides/recurring-schedules) without a handler is the exception: it is handed to another replica instead.
- **Undecodable payload**, a [codec](/docs/guides/custom-codec#decode-error-behavior) mismatch.

The original bytes are preserved either way.

```mermaid
sequenceDiagram
    participant P as Publisher
    participant S as Source Stream
    participant C as Consumer
    participant H as Handler
    participant DLQ as DLQ Stream
    participant CB as onDeadLetter

    P->>S: emit()
    S->>C: deliver (attempt 1..max_deliver)
    C->>H: invoke handler
    H-->>C: fails on every attempt
    Note over C: delivery count == max_deliver
    C->>C: emit TransportEvent.DeadLetter hook
    alt dlq configured
        C->>DLQ: republish with tracking headers
        DLQ-->>C: ack
        opt onDeadLetter also configured
            C->>CB: onDeadLetter(info), notification
            Note over CB: errors here are logged,<br/>message still terminates
        end
        C-->>S: term() original message
    else dlq not configured
        C->>CB: onDeadLetter(info), primary
        CB-->>C: resolved
        C-->>S: term() original message
    end
```

## Built-in DLQ stream

The DLQ stream is on by default: the transport provisions it and republishes exhausted messages to it with no configuration. The one exception is global `provisioning.management: ManagementMode.Manual`, where it stays off until you configure `dlq`. Override it when the defaults do not fit, or turn it off with `dlq: false`:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  dlq: {
    stream: {
      max_age: toNanos(30, 'days'),
    },
  },
})
```

### Defaults

The stream is `{service}__microservice_dlq-stream`, reserves **256 MB** and keeps messages for **30 days** under `Limits` retention, so reading a dead letter does not consume it. Everything else matches the other streams; the [full table](/docs/reference/default-configs#stream-defaults) has the exact values, and `DEFAULT_DLQ_STREAM_CONFIG` is exported if you want to compose overrides on top of it.

Override through `dlq.stream`. Leave `name` out and it is derived from the service name, which keeps DLQ streams predictable across a fleet. Set it to bind to an externally provisioned stream, as [External DLQ](/docs/guides/external-infrastructure#external-dlq) does. Use the exported `dlqStreamName(serviceName)` helper instead of hardcoding the derived pattern.

### Tracking headers

Each republished message carries these headers, so you can investigate, replay or filter without decoding the payload. The exported `JetstreamDlqHeader` enum names them. `Nats-*` headers of the original (`Nats-Msg-Id`, `Nats-TTL`) are dropped, so the copy is neither deduplicated nor expired early.

| Header                 | Contents                                                                     |
| ---------------------- | ---------------------------------------------------------------------------- |
| `x-dead-letter-reason` | Error message from the last failure, from `Error.message` or `String(error)` |
| `x-original-subject`   | Subject the message was published to                                         |
| `x-original-stream`    | Source stream it came from                                                   |
| `x-failed-at`          | ISO 8601 timestamp of entry into the DLQ                                     |
| `x-delivery-count`     | Deliveries before the message was marked dead                                |

### Externally managed stream

To bind to a DLQ stream from Terraform or ArgoCD instead of creating it, set `dlq.stream.name` and `dlq.management: ManagementMode.Manual`. The stream's `subjects` must contain its own name, which the library checks at boot. [External DLQ](/docs/guides/external-infrastructure#external-dlq) has the full example.

## Fallback chain

No message terminates without passing a recovery path:

| Step                                | Condition                              | Outcome                                                                           |
| ----------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| 1. Emit `TransportEvent.DeadLetter` | Always                                 | Observability, independent of configuration                                       |
| 2. Publish to the DLQ stream        | `dlq` configured                       | Up to 3 in-process attempts, since the server never redelivers past `max_deliver` |
| 3. Notify `onDeadLetter`            | Publish succeeded, callback registered | Errors are logged and swallowed; the message still terminates                     |
| 4. Fall back to `onDeadLetter`      | Every publish attempt failed           | Last chance to persist. Success terminates, failure naks                          |
| 5. `nak()`                          | No callback, or the fallback threw     | The message stays in the stream for manual recovery                               |

Step 5 leaves the message visible to operators until recovered by hand or expired by `max_age`, and every occurrence is logged. It is never redelivered: the delivery count already reached `max_deliver`.

## The callback

Without `dlq`, the callback is the primary path. With `dlq`, it is a notification on success and a fallback on failure.

```typescript title="src/app.module.ts"
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  onDeadLetter: async (info) => {
    console.error('Dead letter:', info.subject, info.error);
  },
})
```

:::warning A throwing callback keeps the message in the stream
When the callback is the primary path and throws, the message is `nak`'d instead of terminated, so the data survives. NATS will not deliver it again: it stays until manual recovery (`nats stream get`, a replay tool) or until `max_age`. With the DLQ stream on, the retried DLQ publish comes first and the callback is only the fallback.
:::

### `DeadLetterInfo`

```typescript
interface DeadLetterInfo {
  /** The NATS subject the message was published to. */
  subject: string;
  /** Decoded message payload (already deserialized by the codec). */
  data: unknown;
  /** Raw NATS message headers. */
  headers: MsgHdrs | undefined;
  /** The error that caused the last handler failure. */
  error: unknown;
  /** How many times this message was delivered. */
  deliveryCount: number;
  /** The stream this message belongs to. */
  stream: string;
  /** The stream sequence number (unique within the stream). */
  streamSequence: number;
  /** ISO 8601 timestamp of the message (derived from NATS metadata). */
  timestamp: string;
}
```

### With injected services

A callback that writes to a repository or a queue client needs DI, so it belongs in `forRootAsync()`:

```typescript title="src/app.module.ts"
JetstreamModule.forRootAsync({
  name: 'orders',
  imports: [DlqModule],
  inject: [DlqService],
  useFactory: (dlqService: DlqService) => ({
    servers: ['nats://localhost:4222'],
    onDeadLetter: async (info) => {
      await dlqService.persist(info);
    },
  }),
})
```

```typescript title="src/dlq/dlq.service.ts"
@Injectable()
export class DlqService {
  private readonly logger = new Logger(DlqService.name);

  constructor(private readonly repository: DlqRepository) {}

  async persist(info: DeadLetterInfo): Promise<void> {
    this.logger.error(
      `Dead letter on ${info.subject} (stream: ${info.stream}, seq: ${info.streamSequence})`,
      info.error,
    );

    await this.repository.save({
      subject: info.subject,
      payload: JSON.stringify(info.data),
      error: info.error instanceof Error ? info.error.message : String(info.error),
      deliveryCount: info.deliveryCount,
      stream: info.stream,
      streamSequence: info.streamSequence,
      occurredAt: info.timestamp,
    });
  }
}
```

## Metrics and alerting

`TransportEvent.DeadLetter` fires before the callback, with or without one registered:

```typescript
import { JetstreamModule, TransportEvent } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  hooks: {
    [TransportEvent.DeadLetter]: (info) => {
      metrics.increment('dead_letter_total', {
        stream: info.stream,
        subject: info.subject,
      });
    },
  },
})
```

The hook is synchronous and fire-and-forget, for metrics and logs. The callback is async and awaited, for persistence that must complete before termination. [Lifecycle Hooks](/docs/guides/lifecycle-hooks) compares the two.

## Scope

Dead letters apply to [workqueue](/docs/patterns/events) and [broadcast](/docs/patterns/broadcast) events and to [schedule ticks](/docs/guides/recurring-schedules). [RPC](/docs/patterns/rpc) returns errors to the caller under its own timeout, and [ordered events](/docs/patterns/ordered-events) are auto-acknowledged without an ack/nak cycle, so exhaustion has no meaning there.

## Next

- [Events (Workqueue)](/docs/patterns/events): retry flow and delivery semantics
- [Broadcast Events](/docs/patterns/broadcast): fan-out with per-instance DLQ
- [Lifecycle Hooks](/docs/guides/lifecycle-hooks)
- [Module Configuration](/docs/reference/module-configuration)
