---
sidebar_position: 5
sidebar_label: "Bring Your Own Infrastructure"
title: "Bring Your Own Infrastructure (bind-only mode): NestJS JetStream"
description: "Bind NestJS JetStream to externally managed NATS streams and consumers provisioned by Terraform, ArgoCD, or a platform team. No auto-provisioning."
schema:
  type: Article
  headline: "Bring Your Own Infrastructure (bind-only mode)"
  description: "Bind NestJS JetStream to externally managed NATS streams and consumers provisioned by Terraform, ArgoCD, or a platform team."
  datePublished: "2026-06-12"
  dateModified: "2026-10-23"
---

# Bring Your Own Infrastructure (bind-only mode)

> **Use when:** Terraform, Pulumi or a platform team owns your streams and consumers.
> **You get:** bind-only mode, the checks it runs at startup, and what each failure means.

By default the transport creates and updates every stream and consumer it needs. In **Manual** mode it never creates, updates or migrates an entity: at startup it reads the live state from the server, checks it against the application's handlers, and fails fast with a detailed error when they do not match.

## When to use Manual mode

- Infrastructure is declared in a Terraform or Pulumi workspace that the application is not allowed to change.
- Platform teams gate all NATS resource changes behind a change-management process.
- Several services share one stream and none of them may change its config.
- Stream configuration changes must go through version control, not happen at service startup.

Otherwise keep the default `Auto` mode.

## Quick start

### 1. Provision the stream and consumer externally

The stream and consumer must exist before the application boots. On NATS 2.15 and later, a stream without `max_consumers` is capped at 1000 consumers ([server upgrades](/docs/getting-started/installation#server-upgrades-that-need-a-config-change)). With the `nats` CLI:

```bash
# Stream: workqueue retention, file storage
nats stream add ext_orders_stream \
  --subjects "ext.orders.>" \
  --retention workqueue \
  --storage file \
  --replicas 1 \
  --defaults

# Consumer: durable, explicit ack, covering the handler subject
nats consumer add ext_orders_stream ext_orders_worker \
  --filter "ext.orders.order.created" \
  --ack explicit \
  --max-deliver 3 \
  --deliver all \
  --defaults
```

The same with the [`nats-io/jetstream`](https://registry.terraform.io/providers/nats-io/jetstream/latest) Terraform provider:

```hcl
resource "jetstream_stream" "orders" {
  name        = "ext_orders_stream"
  subjects    = ["ext.orders.>"]
  retention   = "workqueue"
  storage     = "file"
  replicas    = 1
}

resource "jetstream_consumer" "orders_worker" {
  stream          = jetstream_stream.orders.name
  durable_name    = "ext_orders_worker"
  filter_subject  = "ext.orders.order.created"
  ack_policy      = "explicit"
  max_delivery    = 3
  deliver_policy  = "all"
}
```

### 2. Configure the application

```typescript title="src/app.module.ts"
import { JetstreamModule, ManagementMode } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  provisioning: {
    management: ManagementMode.Manual, // every entity is external by default
  },
  events: {
    stream:   { name: 'ext_orders_stream' },      // custom stream name
    consumer: { durable_name: 'ext_orders_worker' }, // custom consumer name
    subjectPrefix: 'ext.orders.',                  // custom subject prefix
  },
})
```

With `provisioning.management: ManagementMode.Manual` set globally, the library binds every stream and consumer it needs without touching their configuration. Handlers do not change.

The dead-letter stream is the exception: under a global `Manual` it is off unless you configure `dlq` explicitly, so the service never fails boot over a stream nobody provisioned. See [External DLQ](#external-dlq).

## ManagementMode semantics

| Value                   | Behavior                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ManagementMode.Auto`   | The library creates the entity if it doesn't exist and updates its config on every startup. **Default.**                     |
| `ManagementMode.Manual` | The library reads the entity's live state but never creates, updates, or migrates it. Fails at boot if the entity is absent. |

### Resolution order

The mode is resolved per entity (stream or consumer), highest priority first:

1. **Per-entity override**: `events.management.stream` / `events.management.consumer`, and the same on `broadcast`, `schedule` and `rpc`. `ordered.management` and `dlq.management` take a bare `ManagementMode`, because neither kind has a durable consumer to manage.
2. **Global default**: `provisioning.management`.
3. **Library default**: `ManagementMode.Auto`.

### Mixed ownership

Modes can differ within one kind. A common case: the platform owns the stream, the library manages the consumer.

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  events: {
    stream:   { name: 'platform_orders_stream' },
    consumer: { durable_name: 'orders-svc_ev-consumer' },
    subjectPrefix: 'platform.orders.',
    management: {
      stream:   ManagementMode.Manual, // platform team owns the stream
      consumer: ManagementMode.Auto,   // library creates/updates the consumer
    },
  },
})
```

## Custom names and subject prefixes

External resources rarely follow the library's [naming convention](/docs/reference/naming-conventions), so Manual mode usually comes with custom names.

### Stream and consumer name

Set `stream.name` and `consumer.durable_name` on the per-kind block:

```typescript
events: {
  stream:   { name: 'my_custom_stream_name' },
  consumer: { durable_name: 'my_custom_consumer_name' },
}
```

### Subject prefix

`subjectPrefix` replaces the subject prefix of one kind. The trailing dot is normalized.

```typescript
events: {
  subjectPrefix: 'company.orders.', // subjects become: company.orders.{pattern}
}
```

When a custom `subjectPrefix` is set:

- Published subjects are `{prefix}{pattern}`, for example `company.orders.order.created`.
- The consumer gets one exact `filter_subjects` entry per registered handler instead of a wildcard.
- One-shot schedule holders move to `{prefix}_sch.`, and the schedule stream's recurring holders to `{prefix}_cron.` (see [Scheduling with a custom prefix](#scheduling-with-a-custom-prefix)).
- Other services reach this one only when their `forFeature()` declares the same prefixes. See [targets with a custom subject prefix](/docs/reference/module-configuration#targets-with-a-custom-subject-prefix).

## Subject contract per kind

The **stream's subjects** must include every subject this service publishes or handles, and the **consumer's filter** every subject it handles. Per kind:

| Kind      | Stream subjects must cover                                                                                                          | Consumer filter                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Event     | Every registered handler subject: a wildcard like `ext.orders.>` or the individual subjects                                         | `filter_subject` or `filter_subjects`, covering each  |
| Command   | Same as event; only when `rpc: { mode: 'jetstream' }`                                                                               | Same as event                                         |
| Broadcast | Every broadcast subject this service registers, `broadcast.{pattern}` unless a custom prefix is set                                 | `filter_subject` or `filter_subjects`                 |
| Ordered   | `{service}__microservice.ordered.{pattern}` unless a custom prefix is set                                                           | Nothing to configure: ordered consumers are ephemeral |
| Schedule  | Tick subjects `{service}__microservice.sched.>` and holders `{service}__microservice._cron.>`, or `{prefix}>` under a custom prefix | The tick subjects only, never `_cron.>`               |
| DLQ       | The DLQ stream's own name, since dead letters publish to a subject equal to it                                                      | Nothing: the transport creates no DLQ consumer        |

Event, command and schedule streams should carry `retention: workqueue`; anything else boots with a warning. The schedule stream also needs `allow_msg_schedules: true`, `allow_msg_ttl: true` and `max_age: 0`, because a holder that ages out stops its schedule without an error. With `allow_msg_schedules: true` on an event stream, its subjects must also cover `{prefix}_sch.>`. Both cases are covered in [Scheduling with a custom prefix](#scheduling-with-a-custom-prefix).

:::warning
Setting broadcast to Manual means the cluster-wide `broadcast-stream` is externally owned. Every service in the cluster that uses broadcast events consumes from that same stream.
:::

## Boot validation

A missing entity throws `JetstreamProvisioningError`; a coverage violation throws a plain `Error`. Warnings go to the `Jetstream:Binder` logger.

### Throws (hard errors)

| Condition                                                                                                                        | Error message summary                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stream not found in NATS                                                                                                         | `Management mode is Manual; the stream must be provisioned externally before boot.`                                                                                                                           |
| Consumer not found in NATS                                                                                                       | `Management mode is Manual; the consumer must be provisioned externally before boot.`                                                                                                                         |
| Consumer filter does not cover one or more registered handler subjects                                                           | `Consumer "…" does not cover the following registered handler subjects: …. Update the consumer's filter_subject / filter_subjects to include them.`                                                           |
| DLQ stream subjects do not contain the DLQ subject                                                                               | `DLQ stream "…" subjects do not cover "…" (dead letters publish to a subject equal to the stream name). Add it to the stream's subjects list.`                                                                |
| Scheduling is enabled (`allow_msg_schedules: true`, or the schedule stream) but stream subjects do not cover the holder wildcard | `Stream "…" has scheduling enabled but its subjects do not cover the schedule prefix "…". Add "…>" to the stream's subjects.`                                                                                 |
| Scheduling is enabled and the consumer filter also matches the holder namespace, or the consumer has no filter                   | `Consumer "…" filter … also matches the schedule namespace "…". Consuming schedule holders removes pending schedules from the stream. Use exact filter_subjects for the registered handler subjects instead.` |

### Warns (advisory)

| Condition                                                                                 | Warning message summary                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event or command stream retention is not `workqueue`                                      | `Stream "…" retention is "…"; expected "workqueue" for reliable at-least-once delivery.`                                                                                                                   |
| Scheduling is enabled but the external stream does not report `allow_msg_schedules: true` | `Stream "…" does not report allow_msg_schedules=true, but scheduling is enabled in the application options. Scheduled publishes will be rejected by the server until the stream allows message schedules.` |
| Consumer has unlimited `max_deliver` but the DLQ is enabled                               | `Consumer "…" has unlimited max_deliver but the DLQ is enabled; messages will never be dead-lettered. Set max_deliver > 0 on the consumer.`                                                                |
| Consumer `ack_wait` is shorter than the computed `ackExtension` interval                  | `Consumer "…" ack_wait (…ms) is shorter than the ackExtension interval (…ms). Messages may redeliver before the handler finishes. Increase ack_wait.`                                                      |
| Schedule stream does not report `allow_msg_ttl: true`                                     | `Stream "…" does not report allow_msg_ttl=true. Every schedule carries a tick TTL, so the server will refuse to store them.`                                                                               |
| Schedule stream `max_age` is not `0`                                                      | `Stream "…" has max_age …ns. A schedule holder that ages out stops its schedule without an error; set max_age to 0.`                                                                                       |
| A `{stream}__migration_backup` stream exists next to the bound stream                     | `Found migration backup "…" for the externally managed stream "…". A previous Auto-managed migration was interrupted and undelivered messages may still reside in the backup. …`                           |

### Boot summary

The startup log lists bound streams as `external (bound)` next to the provisioned ones:

```text
Provisioning 3 stream(s) for "orders":
  - ext_orders_stream [ev] external (bound)
  - broadcast-stream [broadcast] storage=file replicas=1
  - ext_dlq [dlq] external (bound)
  Total per-node file-backed footprint ~ 0.25 GiB (sum of max_bytes; ...)
```

## Self-healing for Manual consumers

When a consumer iterator breaks (reconnect, server restart, external deletion), the [self-healing loop](/docs/reference/edge-cases#consumer-self-healing) rebinds. Auto mode recreates a missing consumer; a Manual consumer is **never recreated**. The loop logs a recoverable error and keeps retrying on the same backoff:

```text
Consumer ext_orders_worker on ext_orders_stream is externally managed and currently absent; waiting for it to be restored.
```

Once the consumer is restored, the next retry succeeds and processing resumes without a restart.

## External DLQ

Under a global `Manual` the dead-letter stream stays off until you configure `dlq`. Name the external stream and bind to it:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  provisioning: { management: ManagementMode.Manual },
  events: {
    stream:   { name: 'ext_orders_stream' },
    consumer: {
      durable_name: 'ext_orders_worker',
      max_deliver: 3,
    },
    subjectPrefix: 'ext.orders.',
  },
  dlq: {
    stream: { name: 'ext_dlq' },
    management: ManagementMode.Manual,
  },
})
```

Dead letters publish to a subject equal to the stream name, so that name must be in the stream's subjects:

```bash
nats stream add ext_dlq \
  --subjects "ext_dlq" \
  --retention limits \
  --storage file \
  --replicas 1 \
  --defaults
```

`dlq.management` takes a bare `ManagementMode`: the transport creates no consumer on the DLQ stream.

## Scheduling with a custom prefix

Two features keep schedule holders in a stream, and each needs its holder namespace inside the stream's subjects but **outside** the consumer filter. A consumer that matches holders acks them away and silently deletes pending schedules, so the binder refuses to boot when the filter covers the holder namespace or the consumer has no filter at all.

| Feature                                                                                   | Holder namespace, default                                        | Holder namespace, custom prefix | Stream subjects must cover         | Consumer filter       |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------- | ---------------------------------- | --------------------- |
| [One-shot `scheduleAt()`](/docs/guides/scheduling) on a stream with `allow_msg_schedules` | `{service}__microservice._sch.` (`broadcast._sch.` on broadcast) | `{prefix}_sch.`                 | The handler subjects and `…_sch.>` | Handler subjects only |
| [Recurring schedules](/docs/guides/recurring-schedules) on the schedule stream            | `{service}__microservice._cron.`                                 | `{prefix}_cron.`                | The tick subjects and `…_cron.>`   | Tick subjects only    |

With a custom prefix one `{prefix}>` wildcard on the stream covers both handler subjects and holders, but the same wildcard on the consumer would swallow the holders. List the handler subjects as exact `filter_subjects` instead, which is what the library itself does in Auto mode:

```bash
# Stream: one wildcard covers ext.orders.order.created and ext.orders._sch.>
nats stream add ext_orders_stream \
  --subjects "ext.orders.>" \
  --retention workqueue \
  --storage file \
  --replicas 1 \
  --defaults

# Consumer: exact handler subjects, never "ext.orders.>"
nats consumer add ext_orders_stream ext_orders_worker \
  --filter "ext.orders.order.created" \
  --ack explicit \
  --max-deliver 3 \
  --deliver all \
  --defaults
```

Without a custom prefix the default filters already stay clear of the holders: the event consumer filters `{service}__microservice.ev.>` and the schedule consumer `{service}__microservice.sched.>`. An external stream then lists the holder wildcard as a second subject, for example `orders__microservice.sched.>` plus `orders__microservice._cron.>`.

The schedule stream has further requirements (`allow_msg_ttl`, `max_age: 0`); see [Subject contract per kind](#subject-contract-per-kind).

## Per-connection management

`provisioning` is a per-connection option, so with [connections](/docs/guides/multi-connection) one connection can bind to externally managed infrastructure while another provisions its own:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  defaultConnection: 'primary',
  connections: {
    primary: { servers: ['nats://primary:4222'] },              // Auto, provisions itself
    regulated: {
      servers: ['nats://regulated:4222'],
      provisioning: { management: ManagementMode.Manual },      // bound, never provisioned
    },
  },
})
```

Under `Manual` the library does not write the ownership stamp that detects two connections reaching one cluster, because those streams are not its to write. The config-level check (two connections with an identical server set) still applies, but two `Manual` connections reaching one cluster through different URLs go undetected. Keep them distinct by convention.

## Interaction with provisioning.allowDestructiveMigration

:::warning
`allowDestructiveMigration: true` together with a global `provisioning.management: Manual` does nothing: Manual streams are never migrated. The library logs a warning at boot:

```text
allowDestructiveMigration has no effect under provisioning.management: Manual; the library never migrates externally managed streams.
```

:::

With mixed ownership the flag applies to the `Auto`-managed streams only. See [Stream Migration](/docs/guides/stream-migration#manual-streams-are-never-migrated).

## What's next?

- [**Stream Migration**](/docs/guides/stream-migration): how the transport migrates Auto-managed streams
- [**Dead Letter Queue**](/docs/guides/dead-letter-queue): DLQ stream configuration
- [**Scheduling**](/docs/guides/scheduling): one-shot delivery and the `_sch.` holders
- [**Recurring schedules**](/docs/guides/recurring-schedules): the schedule stream and its `_cron.` holders
- [**Module Configuration**](/docs/reference/module-configuration): full `management`, `subjectPrefix`, and custom name reference
