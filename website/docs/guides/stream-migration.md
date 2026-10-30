---
sidebar_position: 4
sidebar_label: "Stream Migration"
title: "How to migrate immutable stream properties: NestJS JetStream"
description: "Safely change immutable NATS JetStream stream properties (storage, retention) without losing messages, via automatic blue-green sourcing."
schema:
  type: Article
  headline: "How to migrate immutable stream properties"
  description: "Safely change immutable stream properties without losing messages via blue-green sourcing."
  datePublished: "2026-04-02"
  dateModified: "2026-10-30"
---

# How to migrate immutable stream properties

> **Use when:** a stream property that JetStream will not let you change has to change anyway.
> **You get:** blue-green stream recreation, what it costs, and when it refuses to run.

## When is migration needed?

Most stream config changes are **mutable**: the transport applies them with a plain update on startup. Migration is needed only for **immutable** properties that NATS locks after creation. The [full property classification](/docs/reference/default-configs#immutable-vs-mutable-stream-properties) lists them.

| Property                        | Example change          | Requires migration                           |
| ------------------------------- | ----------------------- | -------------------------------------------- |
| `storage`                       | `File` -> `Memory`      | **Yes**                                      |
| `retention`                     | `Workqueue` -> `Limits` | **Not allowed**: controlled by the transport |
| `max_age`, `num_replicas`, etc. | Any value               | No: mutable, updated automatically           |

## How to enable

```typescript
import { StorageType } from '@nats-io/jetstream';
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  provisioning: { allowDestructiveMigration: true },
  events: {
    stream: { storage: StorageType.Memory },
  },
});
```

Without the flag, the transport logs a warning, applies only the mutable part of the change and keeps the existing stream. Once every pod runs the new config, remove the flag: it is needed only for the migration itself.

## How it works

The transport recreates the stream blue-green via [NATS stream sourcing](https://docs.nats.io/nats-concepts/jetstream/streams#sources), a server-side copy:

```text
Lock       Create the backup stream; only one pod can, the others wait

Phase 1/4  Quiesce: remove the original's subjects
           (new publishes are rejected loudly instead of being acked
            into a stream that is about to be deleted; aborts here if
            the new max_msgs or max_bytes cannot hold what it has)

Phase 2/4  Backup ← sourcing ← original
           (server-side copy; completion is tracked via source lag)

Phase 3/4  Delete original, create it again with the new config

Phase 4/4  Original ← sourcing ← backup
           -> drain -> delete backup -> detach source
```

The stream keeps its name. Each pod's startup or self-healing recreates the consumers afterwards.

Sourcing out of a work-queue stream, such as the event or command stream, acknowledges what it copies. Messages a consumer's filter covers stay in the original as well; any others, for example on a subject whose handler was removed, move into the backup. From Phase 2 on, the backup is therefore the copy that counts, and every failure path below gives it back rather than throwing it away.

A producer either gets an ack (the message survives the migration) or a rejection it can retry, never an ack for a message that later disappears.

### Backup stream as a distributed lock

The backup stream (`{stream}__migration_backup`) holds the messages between delete and recreate, and is also the lock. NATS creates a stream atomically, so of several pods that start a migration at once, exactly one creates the backup and migrates; the rest wait for it to finish and then find nothing left to change.

The pod holding the lock writes a heartbeat into the backup's metadata every 5 seconds. Every other pod waits while that heartbeat keeps changing, and takes the migration over only after watching it stand still for 30 seconds, so a migration of any length is not interrupted while its pod is alive, and clock skew between hosts plays no part. A takeover finishes the migration from where it stopped. The pod that held the lock checks it still does before each destructive step, and stops with a `lock-lost` error if its heartbeat stopped landing or another pod took over. Once it sees another pod's claim on the lock, it never writes to the lock again, so a pod that stalled and wakes up after a takeover cannot win the lock back. Backups left by releases before 3.1 carry no heartbeat; they keep the old rule and count as abandoned 90 seconds after they were created.

:::warning Finish the rollout before a destructive migration
Releases before 3.1 know none of this: they take over any backup older than 90 seconds, and reopen a quiesced stream when they start. Run a destructive migration only once no pod of an older release can start against the cluster.
:::

## What happens during migration

### To publishers

From the quiesce (Phase 1) until the restore completes, publishes to the migrating stream are **rejected**: no stream matches the subject, so producers get "no stream matches subject" or no-responders errors. Both `client.emit()` and `client.send()` reject, and the caller can retry.

The window lasts as long as the copy. That is deliberate: a rejected publish can be retried, while an ack into a stream about to be deleted is silent data loss. For a migration with no rejections at all, pause publishers during a maintenance window.

### To consumers on other pods (rolling updates)

Deleting the stream breaks other pods' consumers. [Self-healing](/docs/reference/edge-cases#consumer-self-healing) retries with backoff, sees the `__migration_backup` stream and **does not recreate the consumer** until the backup is gone. Then the next retry creates it and consumption resumes.

Waiting keeps old pods from overwriting a newer pod's consumer config, and keeps consumers from taking workqueue messages while they are being sourced back.

### To the migrating pod itself

Its startup blocks until all phases complete, then it creates consumers and starts processing.

### To other pods starting up

A pod that starts while another one is migrating a stream it uses waits for that migration before it provisions anything, so it cannot reopen a quiesced stream or recreate consumers halfway through. The wait lasts as long as the migration, plus at least 35 seconds when the migrating pod has died, so give startup probes room for it.

## Duration

Sourcing runs on the server, so no message crosses the network to the application, and the copy is bounded by the server's disk or memory. Duration grows with message count and size. No measured figures are published: time a migration of a realistic stream on your own hardware before a rolling update.

## Error handling

- **Failure before the original is deleted.** Whatever sourcing moved into the backup goes back into the original, the quiesce is rolled back (subjects restored), the backup is removed, and an error is thrown: the original stream has every message and serves traffic. If even that fails, the stream stays quiesced with its backup, and the next pod to take the lock over finishes the job.
- **Failure after the original is deleted.** The backup is the only copy of the data and is always preserved. Restoration resumes automatically on the next application startup.
- **New limits too small.** If the new `max_msgs` or `max_bytes` cannot hold the messages already in the stream, the migration stops before deleting anything and throws a `JetstreamMigrationError` with reason `insufficient-capacity`. Raise the limits, or let consumers drain the stream, and restart. `max_msgs_per_subject` is not checked.
- **Sourcing stalls.** The copy may take as long as it needs; it fails with reason `sourcing-timeout` only after 30 seconds without progress. Before the delete, that rolls back as above; after it, the backup is preserved.
- **Process killed mid-migration.** Its heartbeat stops, and the next pod to start, or one already waiting, takes the migration over 30 seconds later. If the original was never deleted, the backup is given back to it without duplicating what both hold; otherwise it is restored into the stream (recreating it first if the crash happened between delete and create), then cleaned up. The DLQ stream is recovered the same way.
- **Instances migrating concurrently (rolling deploy).** Only the pod that created the backup migrates; see [the lock](#backup-stream-as-a-distributed-lock).

## Manual streams are never migrated

Streams in `ManagementMode.Manual` are never created, updated or migrated, whatever `provisioning.allowDestructiveMigration` says. With mixed ownership the flag applies to the Auto-managed streams only, and combined with a global `Manual` it logs a warning at boot. See [Bring Your Own Infrastructure](/docs/guides/external-infrastructure#interaction-with-provisioningallowdestructivemigration).

## Limitations

- **`retention` is not migratable.** The transport controls it (`Workqueue` for event, command and schedule streams, `Limits` for broadcast, ordered and DLQ). A mismatch throws on startup.
- **The publisher window is inherent.** NATS has no atomic stream rename or swap, so publishes reject from the quiesce until the restore.
- **`provisioning.allowDestructiveMigration` is one flag for every Auto-managed stream of the service.** Any of them with an immutable conflict is migrated.
- **The shared broadcast stream is never migrated.** Recreating `broadcast-stream` would delete every other service's durable consumers and replay retained history to them, so an immutable conflict on it throws instead. Coordinate that change by hand.
- **The schedule stream is never migrated.** NATS refuses to source into a stream with `allow_msg_schedules`, so an immutable conflict on `{service}__microservice_sched-stream` throws. Revert the change, or recreate the stream by hand: the next boot reconciles the schedules declared in decorators, and dynamic schedules have to be created again.
- **Manual streams are never migrated.** See the section above.

## See also

- [Default Configs: Immutable vs mutable stream properties](/docs/reference/default-configs#immutable-vs-mutable-stream-properties): which properties require migration
- [Self-healing consumers](/docs/reference/edge-cases#consumer-self-healing): how consumers on other pods wait out a migration
- [Troubleshooting: Stream migration](/docs/guides/troubleshooting#stream-migration): recovery from interrupted migrations
- [Module Configuration](/docs/reference/module-configuration): `provisioning.allowDestructiveMigration` in the options reference
