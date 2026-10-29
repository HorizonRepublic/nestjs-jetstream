---
sidebar_position: 6
sidebar_label: "Troubleshooting"
title: "Troubleshooting: NestJS JetStream Transport"
description: "Fix common NestJS JetStream issues, from connection errors and consumer lag to RPC timeouts, DLQ publish failures and stream migration recovery."
schema:
  type: Article
  headline: "Troubleshooting: NestJS JetStream Transport"
  description: "Fix common NestJS JetStream issues, from connection errors and consumer lag to RPC timeouts, DLQ publish failures and stream migration recovery."
  datePublished: "2026-03-26"
  dateModified: "2026-10-29"
---

# Troubleshooting

> **Use when:** something is already broken and you want the cause.
> **You get:** symptoms grouped by area, each with its usual causes and the command that confirms them.

## Connection errors

### `NATS connection refused`

Startup throws `NATS connection refused: <servers>` when a critical connection cannot reach the server. A connection with `critical: false` retries in the background instead (see [Multiple connections](/docs/guides/multi-connection#criticality)).

**Causes:** the server is not running, the URL in `servers` is wrong for this environment, or a firewall or network policy blocks the port.

**Fix:**

```bash
nats server check connection --server nats://localhost:4222
```

Load per-environment URLs with `forRootAsync()`:

```typescript
JetstreamModule.forRootAsync({
  name: 'my-service',
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    servers: config.get<string>('NATS_SERVERS')!.split(','),
  }),
})
```

### Reconnection loop

The transport reconnects without limit (`maxReconnectAttempts: -1`). Repeated reconnects mean the server is flapping or something drops the connection.

**Diagnosis:**

1. Register a `Reconnect` hook to see when reconnections happen:

   ```typescript
   hooks: {
     [TransportEvent.Reconnect]: (server) => console.log(`Reconnected to ${server}`),
   }
   ```

2. Check NATS server logs for client disconnect reasons.
3. Verify TLS certificates haven't expired.

## Consumer issues

### Messages not being delivered

**Checklist:**

1. **Handler registered?** The startup log prints `Registered handlers: X RPC, Y events, Z broadcasts`, plus `N ordered` and `N scheduled` when present. A zero count means the decorator never reached the registry: an import-order or module-wiring problem.
2. **Stream and consumer exist?** `nats stream ls`, then `nats consumer ls <stream-name>`.
3. **Subject matches?** `nats sub "servicename__microservice.ev.>"` shows whether messages arrive on the expected subject.
4. **Publisher-only?** With `publisherOnly: true` no handlers are registered.
5. **Right connection?** With [several connections](/docs/guides/multi-connection#binding-handlers), a handler consumes only from the connection it is bound to.

### Messages redelivered unexpectedly

Messages are redelivered when the `ack_wait` deadline expires before the handler acknowledges them.

**Causes:**

- The handler outlives `ack_wait`
- The handler throws, so the message is retried after the retry delay
- The connection dropped during processing

**Fix:** raise `ack_wait` (`consumer: { ack_wait: toNanos(60, 'seconds') }`), enable `ackExtension: true` for long handlers, or cap `concurrency` to prevent overload. See [Performance Tuning](/docs/guides/performance#ack-extension).

### Consumer lag growing

1. **Profile the handler** first: database queries, external API calls and heavy computation are the usual bottlenecks.
2. **Raise `concurrency`** (`events: { concurrency: 200 }`) and **`max_ack_pending`** (`consumer: { max_ack_pending: 500 }`).
3. **Scale horizontally:** each instance takes a share of the workqueue.

Watch the lag:

```bash
nats consumer info <stream> <consumer> | grep "Num Pending"
```

## RPC issues

### `RPC timeout` errors

The caller gets an `rpc.timeout` error when no response arrives in time. The default is 30 s in Core mode and 3 min in JetStream mode, and the deadline also covers waiting for the connection.

**Causes:**

- Handler is slow or stuck
- No handler registered for the pattern
- Network partition between publisher and consumer
- Wrong RPC mode: publisher uses `core` but handler expects `jetstream` (or vice versa)

**Diagnosis:**

```typescript
hooks: {
  [TransportEvent.RpcTimeout]: (subject, correlationId) =>
    console.warn(`RPC timeout: ${subject} (${correlationId})`),
}
```

**Fix:**

- Raise the timeout: `rpc: { mode: 'core', timeout: 60_000 }`, or per request with [`setTimeout()`](/docs/guides/record-builder)
- Use the same RPC mode on both sides

### `No handler for subject` errors

A message arrived on a subject with no registered handler. An event in that state becomes a dead letter at once (see [Dead Letter Queue](/docs/guides/dead-letter-queue)). A Core RPC request gets an error reply.

**Causes:**

- Typo in the `@EventPattern()` or `@MessagePattern()` pattern
- Handler not imported in the module
- Subject naming mismatch between publisher and consumer

**Fix:** Compare the full NATS subject in the warning with your handler patterns. See [Naming Conventions](/docs/reference/naming-conventions) for the subject structure.

## Dead letter queue

### Dead letters are missing

The DLQ stream is on by default and catches workqueue and broadcast events that exhaust `max_deliver` (default 5), plus events with no handler or an undecodable payload. Check what applies:

1. **`dlq: false`?** Then only the `onDeadLetter` callback, if any, sees dead letters.
2. **Global `provisioning.management: Manual`?** The implicit DLQ stays off. Configure `dlq` to [bind an external stream](/docs/guides/external-infrastructure#external-dlq).
3. **RPC or ordered?** Neither dead-letters: RPC returns errors to the caller, and ordered events have no ack cycle.
4. **`max_deliver` unlimited** on an external consumer? Nothing ever exhausts, and the binder warns at boot.

### DLQ stream publish fails

The transport retries the publish, falls back to `onDeadLetter`, and finally `nak()`s the message so it stays in the source stream. The full [fallback chain](/docs/guides/dead-letter-queue#fallback-chain) has the order.

**Causes:** the DLQ stream was deleted (`nats stream rm orders__microservice_dlq-stream`), the server is out of disk or the stream hit `max_bytes`, or the connection dropped before the republish.

**Fix:**

1. Check the stream: `nats stream ls | grep dlq-stream`.
2. If it was deleted, restart the pod: in Auto mode startup recreates it.
3. Check server disk usage: `nats server report accounts`.

## Handler metadata registry

### Entries missing from the KV bucket

The transport only publishes handler metadata when the handler has a `meta` field in its decorator extras. Handlers without `meta` are intentionally skipped, see [Handler Metadata](/docs/patterns/handler-metadata) for the quick-start example.

**Checklist:**

1. Does the handler have `meta: { ... }` in `@EventPattern` / `@MessagePattern`?
2. Did startup succeed? Check logs for `MetadataRegistry` errors.
3. Inspect the bucket: `nats kv ls handler_registry`

### Bucket config mismatch error on startup

NATS KV buckets have immutable config for some fields (`replicas`, `ttl`). If you change these in `forRoot()` after the bucket already exists, startup fails.

**Fix:** Delete your configured metadata bucket. The default name is `handler_registry`, so substitute your own if you overrode `metadata.bucket` in `forRoot()`. Entries are re-published on the next startup, which makes the delete safe.

```bash
# Replace `handler_registry` with your metadata.bucket value if you overrode it
nats kv rm handler_registry

# Restart the service → fresh bucket with new config
```

## Stream migration

### Consumer self-healing waits on "migration in progress"

An interrupted migration (process killed mid-phase, NATS crash) leaves a `{stream}__migration_backup` stream behind. Consumer self-healing, which runs after a live consumer's iterator breaks, refuses to recreate the consumer while that backup exists and retries with backoff.

**Diagnosis:**

```bash
nats stream ls | grep migration_backup
```

**Fix:** usually none: self-healing recovers once the migrating pod finishes and removes the backup, and the next startup of any pod finishes an interrupted restore. If the backup is stranded for good, inspect it, then keep it (it may hold messages you need) or delete it with `nats stream rm <stream>__migration_backup`. See [Stream Migration, Error handling](/docs/guides/stream-migration#error-handling).

### Startup waits on "another instance is migrating it"

A pod that finds a `{stream}__migration_backup` waits before provisioning that stream. While the migrating pod's heartbeat keeps changing it waits for as long as the migration takes; once the heartbeat has stood still for 30 seconds, it takes the migration over and finishes it. A backup left by a release before 3.1 carries no heartbeat and is taken over 90 seconds after it was created. See [the lock](/docs/guides/stream-migration#backup-stream-as-a-distributed-lock).

### Publisher errors during rolling update

From the quiesce until the restore completes, publishes to the migrating stream reject with "no stream matches subject" or no-responders errors. Retry in the caller, or pause publishers during a maintenance window. See [what publishers see](/docs/guides/stream-migration#to-publishers).

## Startup issues

### `Unable to resolve signature of method decorator` on `@EventPattern`

NestJS 12 adds a typed `@EventPattern` overload, and a plain string topic matches it. Under `strict` TypeScript that overload accepts only a handler shaped exactly `(data, ...args: unknown[])`, so a handler with no parameters, or one that takes `@Ctx() ctx: RpcContext`, fails to compile with error TS1241.

**Fix:** pass the topic type explicitly to select the untyped overload. It exists in NestJS 10 and 11 too, so the same code compiles on every supported major:

```typescript
@EventPattern<string>('order.created')
handle(@Payload() data: OrderCreated, @Ctx() ctx: RpcContext): void {}
```

`@MessagePattern` has no typed overload and is unaffected.

### `JetstreamCapabilityError`

```text
Stream orders__microservice_ev-stream (allow_msg_ttl) needs NATS JetStream API level 1 (NATS 2.11 or newer); nats-1 (NATS 2.10.24) reports level 0.
```

A feature needs a newer server than the one the client talks to: `ttl()` / `allow_msg_ttl` need 2.11, `scheduleAt()` / `allow_msg_schedules` 2.12, cron and interval schedules 2.14. Older servers accept these settings and silently ignore them, so the transport fails the boot or the call instead. Upgrade every node in the cluster, or drop the feature. See [NATS server versions](/docs/getting-started/installation#nats-server-versions).

### `Streams on a single replica of a clustered JetStream`

```text
Streams on a single replica of a clustered JetStream: orders__microservice_ev-stream, orders__microservice_dlq-stream. ...
```

The server runs clustered JetStream, but these streams keep the default `num_replicas: 1`, so they go down with their node and are lost with its disk. Set `num_replicas: 3` in each stream override, or `num_replicas: 1` explicitly to keep one replica on purpose. See [Replicas in production](/docs/reference/default-configs#replicas-in-production).

### Boot fails in Manual mode

A bound stream or consumer is missing, or its subjects or filter do not cover the handlers. The error names the entity and the fix. [Boot validation](/docs/guides/external-infrastructure#boot-validation) lists every check.

### `listen() hangs` on startup

1. **NATS connection timeout**: the initial connection attempt blocks startup.
2. **Ordered consumer can't connect**: check that the ordered stream exists.

### `transport-controlled config conflicts`

```text
Stream orders__microservice_ev-stream has transport-controlled config conflicts that cannot be migrated: retention: ...
```

The existing stream has a `retention` the transport does not use for that kind, usually because something else created it. Other immutable changes (such as `storage`) only log a warning unless you enable [stream migration](/docs/guides/stream-migration).

**Fix:** delete the stream and let the transport recreate it:

```bash
nats stream rm <stream-name>
```

:::warning
Deleting a stream destroys all messages in it. Only do this in development or when data loss is acceptable.
:::

## Scheduling

### `JetstreamScheduleError` with reason `server-timezone-data`

```text
The NATS server rejected the time zone of <subject>. The official scratch images carry no time zone data; run an alpine image, or schedule in UTC.
```

The client accepted the IANA time zone of a cron schedule, but the server has no time zone database. Run the `nats:<version>-alpine` image, or drop the `timezone` and schedule in UTC. See [Recurring schedules, Requirements](/docs/guides/recurring-schedules#requirements).

## Typed error handling with `NatsErrorCode`

To react to a JetStream API error in your own code, compare its code with the exported `NatsErrorCode` enum instead of matching on messages. It lists the codes the transport itself reacts to:

```typescript
import { NatsErrorCode } from '@horizon-republic/nestjs-jetstream';

try {
  await jsm.streams.info('orders__microservice_ev-stream');
} catch (err) {
  const code = (err as { code?: number }).code;

  if (code === NatsErrorCode.StreamNotFound) {
    // 10059, stream does not exist yet, safe to create
  } else if (code === NatsErrorCode.ConsumerNotFound) {
    // 10014, consumer was deleted externally
  } else if (code === NatsErrorCode.ConsumerAlreadyExists) {
    // 10148, race on consumer create, fetch the existing one instead
  } else {
    throw err;
  }
}
```

## See also

- [Lifecycle Hooks](/docs/guides/lifecycle-hooks): register hooks for observability
- [Health Checks](/docs/guides/health-checks): monitor connection status
- [Default Configs](/docs/reference/default-configs): all default values
- [Edge Cases](/docs/reference/edge-cases): less obvious behaviors
