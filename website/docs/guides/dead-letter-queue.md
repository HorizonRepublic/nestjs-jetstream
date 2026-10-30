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
  dateModified: "2026-10-30"
---

# How to configure a Dead Letter Queue

> **Use when:** a message has failed every delivery attempt and you need it kept instead of dropped.
> **You get:** the built-in DLQ stream, the `onDeadLetter` callback, and the fallback chain between them.

A message that fails every delivery attempt and reaches `max_deliver` (default **5**) becomes a dead letter. These two mechanisms capture it, and they compose:

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

The stream is `{service}__microservice_dlq-stream`, reserves **256 MB** and keeps messages for **30 days** under `Limits` retention, so reading a dead letter does not consume it. It holds up to 500,000 dead letters; once full it rejects new ones, and each goes to `onDeadLetter` instead. Everything else matches the other streams; the [full table](/docs/reference/default-configs#stream-defaults) has the exact values, and `DEFAULT_DLQ_STREAM_CONFIG` is exported if you want to compose overrides on top of it.

Override through `dlq.stream`. Leave `name` out and it is derived from the service name, which keeps DLQ streams predictable across a fleet. Set it to bind to an externally provisioned stream, as [External DLQ](/docs/guides/external-infrastructure#external-dlq) does. Use the exported `dlqStreamName(serviceName)` helper instead of hardcoding the derived pattern.

### Tracking headers

Each republished message carries these headers, so you can investigate, replay or filter without decoding the payload. The exported `JetstreamDlqHeader` enum names them. `Nats-*` headers of the original (`Nats-Msg-Id`, `Nats-TTL`) are dropped, so the copy is neither deduplicated nor expired early.

| Header                 | Contents                                                                       |
| ---------------------- | ------------------------------------------------------------------------------ |
| `x-dead-letter-reason` | Error message from the last failure, from `Error.message` or `String(error)`   |
| `x-original-subject`   | Subject the message was published to                                           |
| `x-original-stream`    | Source stream it came from                                                     |
| `x-failed-at`          | ISO 8601 timestamp of entry into the DLQ                                       |
| `x-delivery-count`     | Deliveries before the message was marked dead                                  |
| `x-redrive-count`      | Times the message was [redriven](#redriving-dead-letters) before failing again |

### Externally managed stream

To bind to a DLQ stream from Terraform or ArgoCD instead of creating it, set `dlq.stream.name` and `dlq.management: ManagementMode.Manual`. The stream's `subjects` must contain its own name, which the library checks at boot. [External DLQ](/docs/guides/external-infrastructure#external-dlq) has the full example.

## Fallback chain

No message terminates without passing a recovery path:

| Step                                | Condition                                               | Outcome                                                                                                       |
| ----------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1. Emit `TransportEvent.DeadLetter` | Always                                                  | Observability, independent of configuration                                                                   |
| 2. Publish to the DLQ stream        | `dlq` configured                                        | Up to 3 in-process attempts, since the server never redelivers past `max_deliver`. A full DLQ stream gets one |
| 3. Notify `onDeadLetter`            | Publish succeeded, callback registered                  | Errors are logged and swallowed; the message still terminates                                                 |
| 4. Fall back to `onDeadLetter`      | Every publish attempt failed, or the DLQ stream is full | Last chance to persist. Success terminates, failure naks                                                      |
| 5. `nak()`                          | No callback, or the fallback threw                      | The message stays in the stream for manual recovery                                                           |

After step 5 the server reports the exhausted message (see below), so capture runs once more. If that fails too, the message stays visible to operators until recovered by hand or expired by `max_age`, and every occurrence is logged. It is never redelivered: the delivery count already reached `max_deliver`.

## Deliveries no handler settled

A final attempt can also end without the handler failing: the process crashes, a pod is stopped mid-handler, or the handler outlives `ack_wait` (with [ack extension](/docs/guides/performance#ack-extension) off or past its limit). The server then gives up on the message, keeps it in the stream, and publishes a `MAX_DELIVERIES` advisory.

The transport listens for that advisory on every event, broadcast and schedule consumer with a delivery limit, whenever dead letters are enabled. It reads the message back from the stream and runs it through the same fallback chain, with `deliveryCount` from the advisory and an error explaining that no attempt settled it. A captured message is then deleted if its stream has work-queue retention, as event and schedule streams do. Under limits or interest retention, the broadcast stream among them, it stays, because other consumers may still read it.

A handler that is still running when the server gives up is treated the same way: the message is dead-lettered, and whatever the handler does when it finishes is ignored.

Replicas of a service share one queue group, so each advisory is handled by one replica. Each message is captured once: a replica remembers what it captured, a live delivery is not captured if its message has already left the stream, and the DLQ publish carries the stream, sequence and stored time as its message ID, so a repeat within the DLQ stream's duplicate window lands once. Two replicas capturing the same message at the same moment can still both call `onDeadLetter`, so key anything it writes on `stream` and `streamSequence`.

Advisories are plain NATS messages. One sent while no replica is running, for instance during a crash loop on every pod, is not seen, and that message stays in the stream until recovered by hand or expired by `max_age`.

With restricted NATS permissions, the service user needs to subscribe to `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>`, and to call `$JS.API.STREAM.INFO.*`, `$JS.API.STREAM.MSG.GET.*` and `$JS.API.STREAM.MSG.DELETE.*` on its streams.

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

## Redriving dead letters

Once a fix ships, the messages that failed before it can go back to their handlers. `JetstreamDlq` is exported by `JetstreamModule.forRoot()` and works on the DLQ stream; nothing in it runs on its own, so you decide when and what goes back. It has three methods:

| Method                       | What it does                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `inspect(filter?, options?)` | Lists dead letters, oldest first: subject, handler pattern, reason, failure time, counts, headers and payload |
| `redrive(filter?, options?)` | Publishes them back to the subject they failed on, then deletes them from the DLQ                             |
| `purge(filter, options?)`    | Deletes the dead letters a filter selects and returns how many went                                           |
| `purgeAll(options?)`         | Empties the whole DLQ in one server call                                                                      |

Every criterion of the filter must match, and an empty filter selects everything:

| Field                          | Matches                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `subject`                      | The original subject; NATS wildcards `*` and `>` are allowed |
| `pattern`                      | The failed handler's pattern, exactly as declared            |
| `reason`                       | A substring of the failure reason, or a `RegExp`             |
| `failedAfter` / `failedBefore` | The failure time, bounds included                            |
| `fromSeq` / `toSeq`            | The DLQ sequence, bounds included                            |

Options are `connection` (the connection whose DLQ to use; the default one when left out) and `limit` (`inspect` stops at 100 unless told otherwise), plus `dryRun` for `redrive`, `purge` and `purgeAll`, and `maxRedrives` and `perSecond` for `redrive`.

### What a redrive does

Each dead letter is published to its original subject with its original headers and payload, then deleted from the DLQ. The handler sees an ordinary delivery, with the usual retries and dead-lettering if it fails again.

- **Loops stop.** The message carries `x-redrive-count`, raised on every redrive and kept when it fails again. One already redriven `maxRedrives` times (3 by default) is skipped with reason `redrive-limit`.
- **Repeats are deduplicated.** The publish uses the DLQ entry as its message ID, so running a redrive again after a crash between publish and delete adds no duplicate within the target stream's `duplicate_window` (2 minutes by default). Entries that went back but could not be deleted are listed in `notRemoved`.
- **Broadcasts and recurring schedule ticks never go back.** A broadcast is a signal where only the latest state matters, so replaying one that is hours old can roll a cache or a config back; a recurring schedule fires again on its own, so a late tick would run out of turn. They are skipped with reasons `broadcast` and `schedule-tick`; inspect and purge them as usual. A one-off `scheduleAt()` delivery is an ordinary event and goes back like one.
- **Only to a consumer that will deliver it.** Before publishing, the redrive reads the service's durable consumer from the server and checks that its filter covers the subject. With a custom `subjectPrefix` the filter lists exact handler subjects, so a dead letter whose handler was removed or renamed would sit in the stream undelivered; it is skipped with reason `no-consumer` and stays in the DLQ.
- **Failures are reported, not thrown.** A dead letter whose publish fails, for example because its stream is full, stays in the DLQ and is listed under `skipped` with reason `publish-failed` and the error.
- **`perSecond`** paces publishes, so a large redrive does not flood a handler that has just recovered.
- **Dead letters without a working handler come straight back.** One marked "no handler" or "decode failed" fails again the same way unless the code changed, and returns with its redrive count raised.
- **Some of the original publish does not survive.** A per-message TTL was dropped when the message entered the DLQ, so the redriven copy does not expire; the `traceparent` is the original one, so its trace links back to the first attempt.
- **`limit` counts skipped records too.** `redrive({}, { limit: 10 })` looks at ten matching records, whatever happens to them.

The report lists the DLQ sequences that went back (`redriven`), those skipped and why (`skipped`), and those that went back but stayed in the DLQ (`notRemoved`). A dry run fills `redriven` with what would go back and changes nothing.

### Purging

`purge()` refuses an empty filter with a `JetstreamConfigError` (reason `dlq-filter-required`), so a forgotten argument cannot wipe the DLQ. A criterion set to `undefined` counts as absent, so `purge({ subject: undefined })`, say from a missing query parameter, is refused as well. `inspect()`, `redrive()` and `purge()` reject a `fromSeq` or `toSeq` that is not a non-negative integer, and an invalid date, with reason `dlq-filter-invalid`, since `NaN` would otherwise match everything. Emptying all of it takes a call that says so, `purgeAll()`, which the server does in one step. A filter with only `toSeq` is also purged by the server in one call; any other filter is matched on headers, so its matches are read and deleted in batches. Every purge returns how many dead letters went, and `dryRun` counts them instead.

```typescript
await dlq.purgeAll(); // the whole DLQ
await dlq.purge({ toSeq: 1200 }); // everything up to sequence 1200
await dlq.purge({ subject: 'broadcast.>' }); // every broadcast dead letter
```

### Triggering a redrive

Call it from wherever your operators work. An admin endpoint, guarded by your own auth:

```typescript
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { JetstreamDlq, type DeadLetterRecord, type DlqRedriveReport } from '@horizon-republic/nestjs-jetstream';

interface RedriveRequest {
  pattern?: string;
  dryRun?: boolean;
}

@Controller('admin/dlq')
export class DlqAdminController {
  constructor(private readonly dlq: JetstreamDlq) {}

  @Get()
  list(@Query('pattern') pattern?: string): Promise<DeadLetterRecord[]> {
    return this.dlq.inspect({ pattern });
  }

  @Post('redrive')
  redrive(@Body() body: RedriveRequest): Promise<DlqRedriveReport> {
    // Dry run unless asked otherwise: see what would go back first
    return this.dlq.redrive({ pattern: body.pattern }, { dryRun: body.dryRun ?? true });
  }
}
```

Or a one-off script, such as a Kubernetes job run after the fix is deployed:

```typescript
import { NestFactory } from '@nestjs/core';
import { JetstreamDlq } from '@horizon-republic/nestjs-jetstream';

import { AppModule } from './app.module';

const app = await NestFactory.createApplicationContext(AppModule);
const report = await app.get(JetstreamDlq).redrive(
  { pattern: 'order.created', failedAfter: new Date('2026-10-28T00:00:00Z') },
  { perSecond: 50 },
);

console.log(report);
await app.close();
```

With `dlq: false`, or before any service with handlers has created the DLQ stream on that connection, every method throws a `JetstreamConfigError` with reason `dlq-unavailable`.

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
