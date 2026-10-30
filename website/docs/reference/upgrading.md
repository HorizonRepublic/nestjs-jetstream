---
sidebar_label: "Upgrading"
title: "Upgrading NestJS JetStream between major versions"
description: "What changes when you upgrade @horizon-republic/nestjs-jetstream, release by release: renamed options, changed defaults, and how to keep the previous behaviour."
schema:
  type: Article
  headline: "Upgrading NestJS JetStream between major versions"
  description: "Renamed options, changed defaults and how to keep the previous behaviour, release by release."
  datePublished: "2026-10-23"
  dateModified: "2026-10-30"
---

# Upgrading

> **Use when:** you already run this library and are bumping its version.
> **You get:** what changes for you, release by release, and how to restore the previous behaviour.

Newest first. What each release adds is in the [release notes](/docs/reference/release-notes); this page lists only what you may have to act on.

## v3.0 → v3.1

No source changes: every message, class and field from v3.0 keeps working. Two defaults change on the first boot.

### Changed defaults

**Retries last about 100 seconds.** Event, broadcast and schedule consumers now allow `max_deliver: 5`, with redeliveries after `[2000, 10000, 30000, 60000]` ms instead of `max_deliver: 3` after `[2000, 10000]`. A dependency outage of up to a minute and a half no longer sends every message of that window to the DLQ. A message no retry can fix runs its handler five times instead of three and reaches the DLQ after about 100 seconds instead of 12. `max_deliver` is mutable, so existing consumers pick it up in place. To keep the previous curve:

```typescript
events: { consumer: { max_deliver: 3 }, retry: [2_000, 10_000] },
```

A message waiting out its delay keeps its `max_ack_pending` slot; see [retry](/docs/reference/module-configuration#retry) for what that means during an outage.

### Errors where the server used to stay silent

**A full stream rejects the publish.** Event, command and DLQ streams now use `discard: New`, and event and command streams also set `discard_new_per_subject`. Once a stream reaches `max_msgs`, `max_bytes` or `max_msgs_per_subject`, the next publish fails with a `JetstreamPublishError` with reason `stream-full`. Before, the server accepted it and evicted the oldest message, which on a work-queue stream is one no consumer had processed yet. Broadcast, ordered and schedule streams keep `discard: Old`, and so does an event stream with `allow_msg_schedules`, because NATS refuses `discard: New` alongside message schedules. See [Default Configs](/docs/reference/default-configs#stream-defaults).

`discard` is mutable, so the first boot updates existing streams in place, keeping their messages and consumers. Before you deploy:

- **A stream already at a limit starts rejecting right away.** Check `nats stream info` for streams near `max_msgs` or `max_bytes`, and `nats stream subjects` for a subject near `max_msgs_per_subject` (100,000 on events, 10,000 on commands). Raise the limit in the stream override if consumers are behind.
- **The DLQ stream drops its per-subject limit.** Every dead letter shares one subject, so the old limit of 50,000 capped the whole stream and evicted the oldest dead letters; it now holds up to `max_msgs`, 500,000.
- **Handle errors on `emit()`.** A fire-and-forget `client.emit(...).subscribe()` without an error handler used to lose the message silently on the server; now the error surfaces in your process instead.
- **A full DLQ stream skips the retries** and hands the dead letter to `onDeadLetter`. Without a callback, the message stays in its source stream for manual recovery.
- **Streams under `management: Manual` are untouched.** The transport never writes their config.

To keep the previous behaviour for one kind, set it in the stream override:

```typescript
events: { stream: { discard: DiscardPolicy.Old } },
```

**Rolling back to v3.0 needs one manual step.** v3.0 sets `discard: Old` on boot, and NATS refuses that while the stream still has `discard_new_per_subject`, so a v3.0 pod fails to provision. The same happens to a v3.0 pod that restarts during a rolling deploy to v3.1. Before rolling back, turn the flag off on the event and command streams:

```bash
nats stream edit <stream> --no-discard-per-subject
```

### Fixes you may notice

**Shutdown waits for running handlers.** Once consumption stops, the transport waits for handlers already running, so their acks and RPC replies still go out, then drains the connection. Both steps share `shutdownTimeout`, part of which is kept for the drain; whatever is still open at the end is closed. Set `shutdownTimeout` above your slowest handler and below your orchestrator's grace period. See [Graceful Shutdown](/docs/guides/graceful-shutdown#configuring-the-timeout).

**A JetStream-mode RPC survives a brief disconnect.** A call already published keeps waiting for its reply across a reconnect instead of failing at once, since the command still runs once the connection is back. It fails with `connection-lost` only when the connection closes for good, and otherwise ends at its timeout. See [Connection lost](/docs/patterns/rpc#connection-lost).

**RPC outcomes gain `cancelled`.** Unsubscribing from a JetStream-mode `send()` before the reply now ends the trace and reports `RpcCompleted` with `status: 'cancelled'`. A `switch` over `RpcOutcomeStatus` that ends in `never` needs a new case, and an error-rate query on `status!="success"` counts these calls.

**A client on a named connection uses that connection's `rpc` options.** `forFeature({ connection })` now follows the connection's RPC mode and timeout instead of the root ones.

**Health stays down after a connection that serves handlers closes for good.** A client may dial a fresh connection, but handlers do not move to it, so the health indicator keeps reporting that connection as down until the process restarts.

**Health reports stalled consumers.** A consumer stuck in self-healing, for example after a deleted stream or a missing externally managed consumer, was invisible to the indicator. `check()` and `isHealthy()` now add `consuming`, a `consumers` breakdown and, when the connection consumes, `degraded`, so assertions on the exact result shape need updating. By default a stalled consumer only sets `degraded: true` and readiness stays `up`, because such causes hit every replica at once. `isHealthy(key, { requireConsumers: true })` also reports `down` once a consumer has not been live for 30 seconds or the connection has not finished starting. Keep the indicator on readiness only, never liveness, with or without the option. See [Consumption](/docs/guides/health-checks#consumption).

**Consumers resume as soon as NATS reconnects.** After a long outage a consumer waited out up to 30 seconds of retry backoff before consuming again. A reconnect now retries every consumer at once.

**An RPC handler timeout frees its concurrency slot.** A handler still running past `rpc.timeout` no longer blocks new commands, so stuck handlers can exceed `concurrency`.

**`connection_up` follows each named connection.** With several connections, one disconnecting no longer drops every server to `0` until the others reconnect.

**`rpc_timeout_total` names the pattern and the side.** Caller timeouts used to land under `subject="<unmatched>"` and were mixed with handler deadlines. The counter now carries the declared pattern on both sides and a new `side` label, `client` or `server`. Queries that sum or rate the metric keep working; one that selected `subject="<unmatched>"` to find caller timeouts should select `side="client"` instead.

**Calls made after shutdown fail instead of reconnecting.** An `emit()` or `send()` from a handler still running at the end of shutdown, or from any code after it, used to dial a fresh connection that nothing closed, which could keep the process alive. It now fails with `JetstreamConnectionError` and reason `shutting-down`.

**Records built without the builder follow the header rules.** `new JetstreamRecord(data, headers)` skipped the check `setHeader()` makes, so a transport header could redirect an RPC reply and a stray `Nats-Rollup` purged the subject. `emit()` and `send()` now fail with `JetstreamRecordError` and send nothing when such a record carries `x-correlation-id`, `x-reply-to`, `x-error`, `x-schedule-hash`, `x-schedule-pattern`, `x-redrive-count`, or any `Nats-*` header other than `Nats-Expected-*`. Move message IDs, TTLs and schedules to the record's own fields or the builder methods. Optimistic concurrency keeps working: `Nats-Expected-*` headers still pass, and `setHeader()` now accepts them too. See [Optimistic concurrency](/docs/reference/header-contract#optimistic-concurrency).

**DLQ filters reject invalid bounds.** A `fromSeq` or `toSeq` that is not a non-negative integer, or an invalid date, now throws `JetstreamConfigError` with reason `dlq-filter-invalid` instead of matching every dead letter.

**Messages queued behind `concurrency` are no longer redelivered.** A message waiting for a free slot is now kept alive with `msg.working()`, whether or not `ackExtension` is on, and its wait no longer counts against `ackExtension.maxDuration`. Before, a backlog that took longer than `ack_wait` to drain was redelivered and handled twice, and could reach `max_deliver` and the DLQ without a handler ever failing. If no handler starts or finishes for `ackExtension.maxDuration` (5 minutes by default), the pod hands its queue back to other pods. See [Concurrency control](/docs/guides/performance#concurrency-control).

**A handler that outlives `ack_wait` on the last delivery keeps its message.** Its late ack now settles the message, and a late failure reaches the DLQ with the handler's own error. Before, the replica that got the server's `MAX_DELIVERIES` advisory dead-lettered the message while the handler was still running, so a handler that then succeeded left a copy in the DLQ that a redrive would run again. A handler counts as hung after `ackExtension.maxDuration`, 5 minutes by default. This holds when the advisory reaches the replica running the handler; see [Deliveries no handler settled](/docs/guides/dead-letter-queue#deliveries-no-handler-settled) for several replicas.

**Abandoned commands go to the DLQ.** A JetStream-mode command whose only delivery was never settled, because its pod crashed or was stopped mid-handler, used to stay in the command stream until `max_age`, and with `discard_new_per_subject` could make publishes to its subject fail. With dead letters enabled it now goes to the DLQ and `onDeadLetter` once its `ack_wait` runs out, and is removed from the command stream. A redrive skips it with the new reason `command`, and `inspect()` reports its origin as `command`. With restricted permissions, the advisory and stream permissions listed in [Deliveries no handler settled](/docs/guides/dead-letter-queue#deliveries-no-handler-settled) now also apply to the command stream.

**Schedule handler errors count as `handler`.** `jetstream_errors_total` used to file an error thrown by a schedule handler under `context="other"`.

### Additive changes

**Dead letters can go back.** `JetstreamDlq` lists, redrives and purges the DLQ stream, or empties it with `purgeAll()`, with filters, a dry run and a cap on how many times one message is redriven. Broadcasts and recurring schedule ticks are never redriven. `x-redrive-count` joins the reserved headers `setHeader()` refuses. See [Redriving dead letters](/docs/guides/dead-letter-queue#redriving-dead-letters).

**Destructive migration is safe with several pods.** The backup stream is now a real lock: only the pod that creates it migrates, the others wait, and a pod that dies mid-migration is taken over once its heartbeat has stopped for 30 seconds, however long the migration runs. A pod that starts while a migration is running waits for it before provisioning. Sourcing fails only after 30 seconds without progress instead of after 30 seconds in total, an interrupted DLQ migration is resumed, and a migration whose new limits cannot hold the existing messages stops before deleting anything. Run a destructive migration only once every pod runs 3.1: older releases still take over and reopen streams by their own rules. See [Stream Migration](/docs/guides/stream-migration).

**A warning for single-replica streams on a cluster.** On clustered JetStream, streams and the handler metadata bucket left at the default `num_replicas: 1` are named in one startup warning. Set `num_replicas: 3`, or `num_replicas: 1` explicitly to silence it. See [Replicas in production](/docs/reference/default-configs#replicas-in-production).

**Errors are typed.** Errors the transport throws, rejects with or hands to `onDeadLetter` are now `Jetstream<Area>Error` classes with a `reason` field, such as `JetstreamConfigError` or `JetstreamRpcError`. They still extend `Error` and keep their messages, so existing `catch` blocks and message checks behave as before. A full stream rejects with `JetstreamPublishError`, which still extends nats.js `JetStreamApiError`; its `name` is now `JetstreamPublishError`. See [Errors](/docs/reference/errors).

## v2.13 → v3.0

A single-connection service that uses none of the renamed options below upgrades with no source changes. Check the changed defaults, though: they apply on the first boot.

### Renamed and moved options

TypeScript flags each one at compile time. A JavaScript configuration, or a `useFactory` that returns an untyped object, fails at boot with an error that lists every removed option and its replacement, so none of them is silently ignored.

| v2.13                                                                 | v3.0                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `consumer: false`                                                     | `publisherOnly: true`                                                                     |
| `allowDestructiveMigration: true`                                     | `provisioning: { allowDestructiveMigration: true }`                                       |
| `ordered: { deliverPolicy, optStartSeq, optStartTime, replayPolicy }` | `ordered: { consumer: { deliver_policy, opt_start_seq, opt_start_time, replay_policy } }` |
| `dlq: { management: { stream: ManagementMode.Manual } }`              | `dlq: { management: ManagementMode.Manual }`                                              |
| `ordered: { management: { stream: ManagementMode.Manual } }`          | `ordered: { management: ManagementMode.Manual }`                                          |
| `subjects` or `description` under any `stream` override               | removed: both are derived from the service name, or from `subjectPrefix`                  |

```typescript
// v2.13
JetstreamModule.forRoot({
  name: 'gateway',
  servers,
  consumer: false,
  allowDestructiveMigration: true,
  ordered: { deliverPolicy: DeliverPolicy.New },
});

// v3.0
JetstreamModule.forRoot({
  name: 'gateway',
  servers,
  publisherOnly: true,
  provisioning: { allowDestructiveMigration: true },
  ordered: { consumer: { deliver_policy: DeliverPolicy.New } },
});
```

`publisherOnly` inverts the old value: `consumer: false` becomes `publisherOnly: true`. On a named connection it now accepts both values, so one connection can publish only while another consumes.

The `management` object form on `dlq` and `ordered` is still accepted at runtime. Only its `stream` slot was ever read: the dead-letter stream has no consumer, and ordered consumers are ephemeral.

`subjects` and `description` were accepted before and then overwritten, so removing them from your config changes nothing at runtime.

The `ordered.consumer` block also exposes the remaining nats.js ordered-consumer options, `inactive_threshold` and `headers_only` among them. `filter_subjects` stays derived from your handlers.

`dlq: true` is now accepted and means the same as leaving `dlq` unset.

### Changed defaults

**Streams reserve far less storage.** `max_bytes` drops from 5 GB to 512 MB on events, from 5 GB to 1 GB on ordered, from 2 GB to 256 MB on broadcast and from 100 MB to 64 MB on commands. `max_msg_size` drops to 1 MB everywhere, matching the NATS server's own `max_payload` default.

A service used to reserve up to 17 GB before processing a single message, which exhausted a modest file store after one or two deployments. `max_bytes` is mutable, so existing streams pick the new value up on the next boot. Set it back under `events.stream` if you need the old headroom.

**Retries are paced.** A failing handler now naks with a delay from `[2000, 10000]` ms instead of immediately, so three attempts span roughly twelve seconds instead of milliseconds. Pass `events: { retry: false }` for the previous behaviour.

**The dead-letter stream is on by default.** Exhausted messages are republished to `{service}__microservice_dlq-stream` instead of being dropped. Pass `dlq: false` to opt out. Under `provisioning: { management: Manual }` nothing changes unless you configure `dlq` explicitly.

**Node 20 is no longer supported.** The minimum is Node 22.

**`@opentelemetry/api` is a required peer dependency.** The transport has always loaded it at startup, so an app without it failed with `Cannot find module '@opentelemetry/api'` even with tracing off. npm 7+ and pnpm now install it with the package; with Yarn, add it yourself.

**Dead letters cover deliveries no handler settled.** A message whose final delivery ended in a crash, a stopped pod or a handler outliving `ack_wait` now reaches the DLQ and `onDeadLetter`, and is removed from a work-queue stream. Services with restricted NATS permissions need the [advisory and stream permissions](/docs/guides/dead-letter-queue#deliveries-no-handler-settled).

**Ack extension stops after 5 minutes per message.** Set `ackExtension: { maxDuration }` if a handler legitimately runs longer. See [Ack extension](/docs/guides/performance#ack-extension).

### Errors where the server used to stay silent

**Features the server would ignore now raise an error.** On NATS 2.10, `allow_msg_ttl` and TTL headers have no effect, and on NATS 2.11 neither do `allow_msg_schedules` and `scheduleAt()`. The boot or the call now stops with a `JetstreamCapabilityError` where messages used to never expire or never fire. A service that used them on a server too old for them was already broken without knowing it.

The minimum version per feature is in [NATS server versions](/docs/getting-started/installation#nats-server-versions).

### Additive changes

Nothing to do unless you use them.

**`servers` is now optional, paired with `connections`.** Configuration accepts either the flat `servers` form or the new `connections` map, and rejects supplying both. Existing flat configurations are unchanged. Internally they become a single connection called `default`, and stream, consumer and subject names stay exactly as they were. See [Multiple connections](/docs/guides/multi-connection).

**`getClientToken` takes an optional second argument.** `getClientToken(name)` returns the same bare token it always did. `getClientToken(name, connection)` returns a namespaced one, for a client bound to one connection. Existing injections resolve unchanged.

**Lifecycle hooks receive a trailing connection name.** Every callback in `hooks` gains an optional final `connection?: string` parameter, populated only when more than one connection is configured. Hooks that ignore it are unaffected, and single-connection applications see the exact payloads they saw before.

**Streams gain an ownership stamp.** Each provisioned stream carries a `nestjs-jetstream-owner` metadata entry of `{service}:{connection}`, the dead-letter stream included. It catches two connections that reach the same cluster.

Existing streams pick the stamp up through one mutable update on the first boot after upgrading. Messages already in the stream are untouched, and metadata written by anyone else is kept. Nothing is stamped under `provisioning: { management: Manual }`, and the shared broadcast stream is never stamped.

**Metrics accept `@prometheus-io/client`.** `prom-client` was renamed to `@prometheus-io/client`, and either package now works. If both end up installed, startup fails until `metrics.register` names the registry your `/metrics` endpoint serves, because the two global registries are different objects. A service with only `prom-client` installed changes nothing.

**Recurring schedules.** Cron and interval schedules, declared on a handler or created from a client, run on NATS 2.14 or newer. See [recurring schedules](/docs/guides/recurring-schedules). Nothing changes for a service that does not use them.

## v2.12 → v2.13

### `stream.name` and `consumer.durable_name` overrides are honored

Before v2.13 these fields in a kind's `overrides` were accepted and ignored in favour of the [naming conventions](/docs/reference/naming-conventions). From v2.13 the transport uses or creates entities under the names you set, which is what binding to [externally managed infrastructure](/docs/guides/external-infrastructure) relies on.

A name set by accident now takes effect too, so remove any you did not mean before upgrading. Nothing else changes, and a service without these fields is unaffected.
