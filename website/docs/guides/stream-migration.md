---
sidebar_position: 4
sidebar_label: "Stream Migration"
title: "How to migrate immutable stream properties — NestJS JetStream"
description: "Safely change immutable NATS JetStream stream properties (storage, retention) without losing messages, via automatic blue-green sourcing."
schema:
  type: Article
  headline: "How to migrate immutable stream properties"
  description: "Safely change immutable stream properties without losing messages via blue-green sourcing."
  datePublished: "2026-04-02"
  dateModified: "2026-06-12"
---

import Since from '@site/src/components/Since';

# How to migrate immutable stream properties

<Since version="2.9.0" />

Safely change immutable stream properties (like `storage`) without losing messages. The transport handles recreation automatically via NATS stream sourcing.

## When is migration needed?

Most stream config changes are **mutable** — the transport applies them on startup via a simple update. No downtime, no message loss. See the [full property classification](/docs/reference/default-configs#immutable-vs-mutable-stream-properties).

Migration is only needed for **immutable** properties that NATS locks after stream creation:

| Property | Example change | Requires migration |
|----------|---------------|-------------------|
| `storage` | `File` -> `Memory` | **Yes** |
| `retention` | `Workqueue` -> `Limits` | **Not allowed** — controlled by the transport |
| `max_age`, `num_replicas`, etc. | Any value | No — mutable, updated automatically |

## How to enable

```typescript
import { StorageType } from '@nats-io/jetstream';
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  allowDestructiveMigration: true,
  events: {
    stream: { storage: StorageType.Memory },
  },
});
```

Without `allowDestructiveMigration`, the transport logs a warning and continues with the existing stream config.

## How it works

The transport uses **blue-green recreation** via [NATS stream sourcing](https://docs.nats.io/nats-concepts/jetstream/streams#sources) — a server-side message copy mechanism that preserves all messages:

```text
Phase 1/4  Quiesce: remove the original's subjects
           (new publishes are rejected loudly instead of being acked
            into a stream that is about to be deleted)

Phase 2/4  Create backup stream ← sourcing ← original
           (server-side copy; completion is tracked via source lag)

Phase 3/4  Delete original, create it again with the new config

Phase 4/4  Original ← sourcing ← backup
           -> drain -> delete backup -> detach source
```

The stream keeps its original name. Consumers are recreated automatically after migration by each pod's startup sequence or self-healing.

Every acknowledged publish is preserved: a producer either gets a successful ack (the message survives the migration) or a loud rejection it can retry — never an ack for a message that later disappears.

### Backup stream as a distributed lock

During migration, the backup stream (`{stream}__migration_backup`) serves a dual purpose:

1. **Temporary message storage** between delete and recreate
2. **Distributed lock** — other pods' self-healing detects the backup and waits instead of recreating consumers, preventing interference with message restoration

## What happens during migration

### To publishers

From the quiesce (Phase 1) until the restore completes, publishes to the migrating stream are **rejected** — the subject has no stream behind it, so producers receive "no stream matches subject" / no-responders errors.

- **`client.emit()`** (fire-and-forget) — the publish rejects with an error. Implement retry logic in the caller if you need delivery during migration.
- **`client.send()`** (RPC) — the caller receives an error and can retry.

The rejection window lasts as long as the message copy does — milliseconds for small streams. This is deliberate: a rejected publish is retryable, while an acknowledged write into a stream that is about to be deleted would be silent data loss. If you need a zero-rejection migration, schedule it during a maintenance window with publishers paused.

### To consumers on other pods (rolling updates)

When one pod migrates the stream, other pods' consumers break because the stream is deleted. The self-healing flow handles this automatically:

1. Consumer iterator breaks → self-healing activates with exponential backoff
2. Recovery detects `__migration_backup` exists → **does NOT recreate the consumer** (waits)
3. Migration completes → backup deleted → next retry creates consumer → consumption resumes

This prevents two critical issues:
- **Config overwrite** — old pods cannot overwrite a newer pod's consumer configuration
- **Message consumption during restore** — consumers cannot eat messages from the workqueue while they're being sourced back

### To the migrating pod itself

The pod that triggers migration blocks during startup until all phases complete. After migration, it creates consumers normally and begins processing.

## Performance

Migration speed depends on message count, message size, and NATS server performance. Stream sourcing is a server-side operation — no messages travel back over the network — so throughput is bounded by the NATS server's disk or memory, not the transport.

Expect migration time to scale roughly linearly with message count. For small streams (thousands of messages) the migration is effectively instantaneous from an operator's standpoint; for very large streams (hundreds of thousands or more), measure on your own hardware before scheduling a rolling update. Proper benchmarks will be published alongside the broader performance suite.

## Error handling

- **Failure before the original is deleted.** The quiesce is rolled back (subjects restored), the backup is removed, and an error is thrown — the original stream is intact and serving traffic.
- **Failure after the original is deleted.** The backup is the only copy of the data and is always preserved. Restoration resumes automatically on the next application startup.
- **Sourcing timeout (30s default).** Same as above: the backup is preserved and the restore resumes on the next startup. Nothing is lost.
- **Process killed mid-migration.** Detected on the next startup: a stranded backup is restored into the stream (recreating it first if the crash happened between delete and create), then cleaned up.
- **Two instances migrating concurrently (rolling deploy).** Backups carry a freshness stamp. An instance that finds another instance's live backup waits for that migration to finish instead of interfering; only stale leftovers are recovered.

## Manual streams are never migrated

Streams managed in `ManagementMode.Manual` (externally provisioned) are never created, updated, or migrated by the library; regardless of `allowDestructiveMigration`. The library only binds to them and validates their configuration at boot.

Setting `allowDestructiveMigration: true` together with a global `provisioning.management: ManagementMode.Manual` is therefore a no-op for all streams. The library logs a warning at boot when this combination is detected:

```
allowDestructiveMigration has no effect under provisioning.management: Manual — the library never migrates externally managed streams.
```

If you use **mixed ownership** (some streams Auto, some Manual), `allowDestructiveMigration` applies only to the Auto-managed streams.

See [Bring Your Own Infrastructure](/docs/guides/external-infrastructure) for the full bind-only mode guide.

## Limitations

- **`retention` is not migratable.** It is controlled by the transport (`Workqueue` for events/commands, `Limits` for broadcast/ordered). A mismatch always throws an error on startup.
- **The publisher gap is inherent.** NATS does not support atomic stream rename or swap. The millisecond window between delete and create cannot be eliminated.
- **`allowDestructiveMigration` applies to all service-owned streams.** It's a single flag at the module level — if any of them has an immutable conflict, it will be migrated.
- **The shared broadcast stream is never destructively migrated.** `broadcast-stream` is shared by every service in the cluster; recreating it would delete other services' durable consumers and replay retained history to them. An immutable conflict on it throws an error instead — coordinate that change manually.
- **Manual streams are never migrated.** See the section above.

## Example: switching to in-memory streams

A common use case is switching from `File` (persistent disk) to `Memory` (RAM) storage for lower latency in development or staging:

```typescript
// Before — File storage (default)
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
});

// After — Memory storage with migration enabled
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  allowDestructiveMigration: true,
  events: { stream: { storage: StorageType.Memory } },
  broadcast: { stream: { storage: StorageType.Memory } },
  ordered: { stream: { storage: StorageType.Memory } },
});
```

After all pods restart with the new config, you can remove `allowDestructiveMigration` — it's only needed for the migration itself:

```typescript
// After migration — remove the flag
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  events: { stream: { storage: StorageType.Memory } },
  broadcast: { stream: { storage: StorageType.Memory } },
  ordered: { stream: { storage: StorageType.Memory } },
});
```

## See also

- [Default Configs — Immutable vs mutable stream properties](/docs/reference/default-configs#immutable-vs-mutable-stream-properties) — which properties require migration
- [Self-healing consumers](/docs/reference/edge-cases#consumer-self-healing) — how consumers on other pods wait out a migration
- [Troubleshooting — Stream migration](/docs/guides/troubleshooting#stream-migration) — recovery from interrupted migrations
- [Module Configuration](/docs/reference/module-configuration) — `allowDestructiveMigration` in the options reference
