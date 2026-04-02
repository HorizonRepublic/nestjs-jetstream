---
sidebar_position: 4
title: "Stream Migration"
schema:
  type: Article
  headline: "Stream Migration"
  description: "Safe stream recreation for immutable property changes with automatic message preservation via blue-green sourcing."
  datePublished: "2026-04-02"
  dateModified: "2026-04-02"
---

import Since from '@site/src/components/Since';

# Stream Migration

<Since version="2.9.0" />

Safely change immutable stream properties (like `storage`) without losing messages. The transport handles recreation automatically via NATS stream sourcing.

## When is migration needed?

Most stream config changes are **mutable** — the transport applies them on startup via a simple update. No downtime, no message loss. See the [full property classification](/docs/reference/default-configs#immutable-vs-mutable-stream-properties).

Migration is only needed for **immutable** properties that NATS locks after stream creation:

| Property | Example change | Requires migration |
|----------|---------------|-------------------|
| `storage` | `File` → `Memory` | **Yes** |
| `retention` | `Workqueue` → `Limits` | **Not allowed** — controlled by the transport |
| `max_age`, `num_replicas`, etc. | Any value | No — mutable, updated automatically |

## How to enable

```typescript
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

```
Phase 1  Create backup stream ← sourcing ← original
         (server-side copy, no application-level consumption)

Phase 2  Delete original stream

Phase 3  Create original stream with new config (e.g., Memory storage)

Phase 4  Original ← sourcing ← backup
         (restore all messages into the new stream)

Phase 5  Delete backup stream
```

The stream keeps its original name. Consumers are recreated automatically after migration by each pod's startup sequence or self-healing.

### Backup stream as a distributed lock

During migration, the backup stream (`{stream}__migration_backup`) serves a dual purpose:

1. **Temporary message storage** between delete and recreate
2. **Distributed lock** — other pods' self-healing detects the backup and waits instead of recreating consumers, preventing interference with message restoration

## What happens during migration

### To publishers

There is a **brief window** (typically milliseconds) between Phase 2 (delete) and Phase 3 (create) where the stream does not exist. Publishers will receive "stream not found" errors during this window.

- **`client.emit()`** (fire-and-forget) — the event is lost. If you need guaranteed delivery during migration, implement retry logic in the caller.
- **`client.send()`** (RPC) — the caller receives an error and can retry.

For most services, this window is too short to matter. If you need zero-loss guarantees during migration, schedule it during a maintenance window with publishers paused.

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

Migration speed depends on message count and NATS server performance. Benchmarks on a single-node NATS 2.12.6 (Testcontainers):

| Messages | File → Memory | Memory → File |
|----------|--------------|--------------|
| 100 | < 1ms | < 1ms |
| 10,000 | ~500ms | ~500ms |
| 100,000 | ~3s | ~3s |
| 1,000,000 | ~6s | ~5s |

Stream sourcing is a server-side operation — no messages travel over the network. Performance scales linearly with message count.

## Error handling

| Failure | Behavior |
|---------|----------|
| Backup creation fails | Original stream untouched, error thrown |
| Process killed mid-migration | Orphaned backup detected on next startup, cleaned up, migration retried |
| NATS connection lost | Transport reconnects, migration resumes from the beginning |
| Sourcing timeout (30s default) | Backup cleaned up, error thrown, original stream untouched (backup was created before delete) |

## Limitations

- **`retention` is not migratable.** It is controlled by the transport (`Workqueue` for events/commands, `Limits` for broadcast/ordered). A mismatch always throws an error on startup.
- **The publisher gap is inherent.** NATS does not support atomic stream rename or swap. The millisecond window between delete and create cannot be eliminated.
- **Very large streams (100k+) during rolling updates.** Server-side sourcing is fast, but if another pod's self-healing creates a consumer during Phase 4, it could consume messages from the workqueue before restoration completes. For very large streams, scale down to 1 pod before migrating.
- **`allowDestructiveMigration` applies to all streams.** It's a single flag at the module level. You cannot enable migration for the event stream but not the broadcast stream — if any stream has an immutable conflict, it will be migrated.

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
