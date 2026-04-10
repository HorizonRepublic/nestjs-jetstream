---
sidebar_position: 6
sidebar_label: "Troubleshooting"
title: "Troubleshooting — NestJS JetStream Transport"
description: "Fix common NestJS JetStream issues: NATS connection errors, consumer lag, RPC timeouts, DLQ publish failures, and stream migration recovery."
schema:
  type: Article
  headline: "Troubleshooting — NestJS JetStream Transport"
  description: "Fix common NestJS JetStream issues: NATS connection errors, consumer lag, RPC timeouts, DLQ publish failures, and stream migration recovery."
  datePublished: "2026-03-26"
  dateModified: "2026-04-11"
---

# Troubleshooting

If something isn't working, start here. The sections below are grouped by symptom — scan them before opening an issue.

## Connection errors

### `NATS connection refused`

The transport throws this on startup when the NATS server is unreachable.

**Causes:**
- NATS server is not running
- Wrong server URL in `servers` config
- Firewall or network policy blocking the port

**Fix:**
```bash
# Verify NATS is running
nats-server --version
docker ps | grep nats

# Test connectivity
nats server check connection --server nats://localhost:4222
```

### `CONNECTION_REFUSED` in production

If the app crashes immediately on deploy, ensure the NATS server URL is correct for the environment. Use `forRootAsync()` with `ConfigService` to load URLs from environment variables:

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

The transport defaults to unlimited reconnection (`maxReconnectAttempts: -1`). If you see repeated `Reconnecting...` logs, the NATS server is flapping or the connection is being dropped.

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
1. **Handler registered?** — Check startup logs for `Registered handlers: X RPC, Y events, Z broadcasts`.
2. **Stream exists?** — The transport creates streams on startup. Check with `nats stream ls`.
3. **Consumer exists?** — Check with `nats consumer ls <stream-name>`.
4. **Subject matches?** — Use `nats sub "servicename__microservice.ev.>"` to see if messages arrive on the expected subject.
5. **Publisher-only mode?** — If `consumer: false` is set, no handlers are registered.

### Messages redelivered unexpectedly

Messages are redelivered when the `ack_wait` deadline expires before the handler acknowledges them.

**Causes:**
- Handler is too slow (exceeds `ack_wait`)
- Handler throws an error (message is nak'd for retry)
- Connection lost during processing

**Fix:**
- Increase `ack_wait`: `consumer: { ack_wait: toNanos(60, 'seconds') }`
- Enable `ackExtension: true` for long-running handlers
- Set explicit `concurrency` to prevent overload

### Consumer lag growing

If your consumer is falling behind (messages accumulating faster than they're processed):

1. **Increase concurrency:** `events: { concurrency: 200 }`
2. **Increase `max_ack_pending`:** `consumer: { max_ack_pending: 500 }`
3. **Scale horizontally:** Deploy more instances — each gets a share of the workqueue messages.
4. **Check handler performance:** Profile your handlers. Database queries, external API calls, and heavy computations are common bottlenecks.

Monitor lag with the NATS CLI:
```bash
nats consumer info <stream> <consumer> | grep "Num Pending"
```

## RPC issues

### `RPC timeout` errors

The caller didn't receive a response within the timeout period.

**Causes:**
- Handler is slow or stuck
- No handler registered for the pattern
- Network partition between publisher and consumer
- Wrong RPC mode — publisher uses `core` but handler expects `jetstream` (or vice versa)

**Diagnosis:**
```typescript
hooks: {
  [TransportEvent.RpcTimeout]: (subject, correlationId) =>
    console.warn(`RPC timeout: ${subject} (${correlationId})`),
}
```

**Fix:**
- Increase timeout: `rpc: { mode: 'core', timeout: 60_000 }`
- Per-request timeout: `new JetstreamRecordBuilder(data).setTimeout(120_000).build()`
- Ensure both sides use the same RPC mode

### `No handler for subject` warnings

A message arrived on a subject that has no registered handler.

**Causes:**
- Typo in the `@EventPattern()` or `@MessagePattern()` pattern
- Handler not imported in the module
- Subject naming mismatch between publisher and consumer

**Fix:** Compare the full NATS subject in the warning with your handler patterns. See [Naming Conventions](/docs/reference/naming-conventions) for the subject structure.

## Dead letter queue

### `onDeadLetter` not called

The callback only fires when **all** of these conditions are met:
1. `onDeadLetter` is configured in module options
2. The message has been delivered `max_deliver` times (default: 3)
3. The handler throws on every delivery attempt

**Not applicable to:**
- RPC commands (they use `term`, not DLQ)
- Ordered events (no ack/nak)
- Messages that are `term`'d (decode errors, missing handlers)

### DLQ callback throws

If your `onDeadLetter` callback throws, the message is nak'd for another retry instead of being terminated. This is intentional — it allows transient failures (e.g., DLQ database is down) to recover.

### DLQ stream publish fails

When `dlq: { stream }` is configured, the transport republishes exhausted messages to a dedicated DLQ stream. If that publish fails, the transport falls back to the `onDeadLetter` callback and then to `nak()` as a last resort — the full sequence is documented in the [Fallback chain](/docs/guides/dead-letter-queue#fallback-chain).

**Causes:**
- DLQ stream was deleted manually (`nats stream rm orders__microservice_dlq-stream`)
- NATS server is out of disk space or has hit `max_bytes`
- NATS connection dropped between the original publish and the DLQ republish

**Fix:**
1. Check that the DLQ stream exists: `nats stream ls | grep dlq-stream`
2. If it was deleted, restart the pod — the transport's `ensureDlqStream()` recreates it on startup when `dlq` is configured
3. Check NATS server disk usage: `nats server report accounts`
4. Ensure the `dlq.stream` config (if overridden) is compatible with the server's resource limits

## Handler metadata registry

### Entries missing from the KV bucket

The transport only publishes handler metadata when the handler has a `meta` field in its decorator extras. Handlers without `meta` are intentionally skipped — see [Handler Metadata](/docs/patterns/handler-metadata) for the quick-start example.

**Checklist:**
1. Does the handler have `meta: { ... }` in `@EventPattern` / `@MessagePattern`?
2. Is the NATS server version >= 2.10 (KV support)?
3. Did startup succeed? Check logs for `MetadataRegistry` errors.
4. Inspect the bucket: `nats kv ls handler_registry`

### Bucket config mismatch error on startup

NATS KV buckets have immutable config for some fields (`replicas`, `ttl`). If you change these in `forRoot()` after the bucket already exists, startup fails.

**Fix:**
```bash
# Delete the bucket (safe — entries are re-published on restart)
nats kv rm handler_registry

# Restart the service → fresh bucket with new config
```

## Stream migration

### Startup blocks on "migration in progress"

If a previous migration was interrupted (process killed mid-phase, NATS crash), an orphaned `{stream}__migration_backup` stream exists. The transport detects it on startup and retries migration from scratch. This can take a few seconds for large streams.

**Diagnosis:**
```bash
nats stream ls | grep migration_backup
```

**Fix:** None needed in most cases — the transport handles recovery automatically. If recovery fails repeatedly, manually inspect the backup stream and either retain it (if it contains messages you need) or delete it (`nats stream rm <stream>__migration_backup`) and retry startup.

See [Stream Migration — Error handling](/docs/guides/stream-migration#error-handling) for the full recovery flow.

### Publisher errors during rolling update

During the brief window between Phase 2 (delete) and Phase 3 (create) of a stream migration, publishers may see "stream not found" errors. The window is effectively one NATS round-trip, but is not zero. Mitigations:

- For `client.emit()` (fire-and-forget), accept the loss or implement caller-side retry.
- For `client.send()` (RPC), the caller receives an error and can retry.
- For zero-loss migrations, schedule migration during a maintenance window with publishers paused.

## Startup issues

### `listen() hangs` on startup

If the application doesn't finish starting:
1. **Ordered consumer can't connect** — The stream might not exist yet. Check that the ordered stream is created before the consumer tries to connect.
2. **NATS connection timeout** — The initial connection attempt blocks startup.

### `Stream already exists with different config`

NATS returns an error when you try to update a stream with incompatible changes (e.g., changing retention policy on an existing stream).

**Fix:** Delete the stream and let the transport recreate it:
```bash
nats stream rm <stream-name>
```

:::caution
Deleting a stream destroys all messages in it. Only do this in development or when data loss is acceptable.
:::

## See also

- [Lifecycle Hooks](/docs/guides/lifecycle-hooks) — register hooks for observability
- [Health Checks](/docs/guides/health-checks) — monitor connection status
- [Default Configs](/docs/reference/default-configs) — all default values
- [Edge Cases](/docs/reference/edge-cases) — less obvious behaviors
