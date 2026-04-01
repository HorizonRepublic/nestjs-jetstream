---
sidebar_position: 6
title: "Troubleshooting"
schema:
  type: Article
  headline: "Troubleshooting"
  description: "Common issues and how to resolve them."
  datePublished: "2026-03-26"
  dateModified: "2026-03-26"
---

# Troubleshooting

Common issues and how to resolve them.

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
