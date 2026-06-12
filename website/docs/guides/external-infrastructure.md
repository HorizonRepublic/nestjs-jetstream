---
sidebar_position: 5
sidebar_label: "Bring Your Own Infrastructure"
title: "Bring Your Own Infrastructure (bind-only mode) — NestJS JetStream"
description: "Bind NestJS JetStream to externally managed NATS streams and consumers provisioned by Terraform, ArgoCD, or a platform team. No auto-provisioning."
schema:
  type: Article
  headline: "Bring Your Own Infrastructure (bind-only mode)"
  description: "Bind NestJS JetStream to externally managed NATS streams and consumers provisioned by Terraform, ArgoCD, or a platform team."
  datePublished: "2026-06-12"
  dateModified: "2026-06-12"
---

import Since from '@site/src/components/Since';

# Bring Your Own Infrastructure (bind-only mode)

<Since version="2.10.0" />

By default, the transport provisions and updates every JetStream stream and consumer it needs. If your organization owns the infrastructure layer — Terraform, ArgoCD, Helm, or a dedicated platform team — you can opt out of that auto-management and instead tell the library to bind to resources that already exist.

In **Manual** mode the library never creates, updates, or migrates an entity. At startup it reads the live state from the NATS server, validates that it is suitable for the application's handlers, and fails fast with a detailed error when it is not.

## When to use Manual mode

- Infrastructure is declared in a Terraform or Pulumi workspace that the application is not allowed to change.
- Platform teams gate all NATS resource changes behind a change-management process.
- You run multiple services sharing the same stream and do not want any single service to modify the stream config.
- You want audit-trail guarantees: stream configuration changes must go through version control, not happen silently at service startup.

:::tip
If none of the above apply, the default `Auto` mode is simpler — the transport provisions everything and keeps it up to date without any extra configuration.
:::

## Quick start

### 1. Provision the stream and consumer externally

The stream and consumer must exist before the application boots. Use whatever tool your team uses — the example below uses the `nats` CLI:

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

If you prefer Terraform, a typical block using the [`nats-io/jetstream`](https://registry.terraform.io/providers/nats-io/jetstream/latest) provider looks like this:

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

Point the transport at the external names and tell it to bind instead of provision:

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

With `provisioning.management: ManagementMode.Manual` set globally, the library binds every entity it needs (streams, consumers, DLQ stream) without touching their configuration.

### 3. Write handlers as usual

Nothing changes on the handler side:

```typescript
import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

@Controller()
export class OrdersController {
  @EventPattern('order.created')
  handleOrderCreated(@Payload() data: unknown): void {
    // handler is called when the consumer delivers the message
  }
}
```

## ManagementMode semantics

`ManagementMode` is an enum with two values:

| Value | Behavior |
|---|---|
| `ManagementMode.Auto` | The library creates the entity if it doesn't exist and updates its config on every startup. **Default.** |
| `ManagementMode.Manual` | The library reads the entity's live state but never creates, updates, or migrates it. Fails at boot if the entity is absent. |

### Resolution order

The mode is resolved per entity (stream or consumer) using the following chain, from highest to lowest priority:

1. **Per-entity override** — `events.management.stream` / `events.management.consumer` (and the equivalent on `broadcast`, `ordered`, `rpc`, `dlq`).
2. **Global default** — `provisioning.management`.
3. **Library default** — `ManagementMode.Auto` when neither of the above is set.

### Mixed ownership

You can mix modes within a single kind. A common case is owning the stream externally while letting the library manage the consumer:

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

In this configuration the library binds to `platform_orders_stream` without touching it, and creates or updates `orders-svc_ev-consumer` normally on every startup.

## Custom names and subject prefixes

Manual mode is typically paired with custom names because the external resource uses a name that differs from the library's default convention.

### Stream and consumer name

Override the stream and consumer names via the `stream.name` and `consumer.durable_name` fields on the per-kind block:

```typescript
events: {
  stream:   { name: 'my_custom_stream_name' },
  consumer: { durable_name: 'my_custom_consumer_name' },
}
```

### Subject prefix

The `subjectPrefix` field changes the subject pattern used to build and match subjects for a given kind. The trailing dot is normalized automatically.

```typescript
events: {
  subjectPrefix: 'company.orders.', // subjects become: company.orders.{pattern}
}
```

When a custom `subjectPrefix` is set:

- Published subjects use `{prefix}{pattern}` instead of the default convention (e.g., `company.orders.order.created`).
- The consumer receives exact `filter_subjects` entries for each registered handler instead of a single wildcard filter.
- Scheduling subjects live under `{prefix}_sch.` instead of the default `{service}__microservice._sch.` prefix (see [Scheduling with a custom prefix](#scheduling-with-a-custom-prefix) below).

## Subject contract per kind

When the library binds to an external entity it validates that the entity's configuration satisfies certain requirements. The table below describes what each kind needs from an externally provisioned stream and consumer.

### Event stream (workqueue)

| Requirement | What to configure externally |
|---|---|
| Stream subjects must cover all registered handler subjects | Add a wildcard like `ext.orders.>` or list individual subjects |
| Consumer filter must cover all registered handler subjects | Set `filter_subject` or `filter_subjects` to include each subject |
| `retention: workqueue` is strongly recommended | Validated with a warning if absent |
| If `allow_msg_schedules: true` is set in the app config, the stream subjects must also cover `{prefix}_sch.>` | Add the schedule wildcard to the stream's subjects |

### Command stream (JetStream RPC mode)

Same requirements as the event stream. Only applies when `rpc: { mode: 'jetstream' }` is configured.

### Broadcast stream

| Requirement | What to configure externally |
|---|---|
| Stream subjects must cover all broadcast subjects registered by this service | Each broadcast subject follows the `broadcast.{pattern}` convention unless a custom prefix is set |
| Consumer filter must cover all broadcast handler subjects | Set `filter_subject` or `filter_subjects` |

:::warning
Setting broadcast to Manual means the shared cluster-wide `broadcast-stream` is externally owned. Every service in the cluster that uses broadcast events will consume from that same stream.
:::

### Ordered stream

| Requirement | What to configure externally |
|---|---|
| Stream subjects must cover all ordered-event subjects registered by this service | Subjects use the `{service}__microservice.ordered.{pattern}` convention unless a custom prefix is set |
| Consumer filter (ordered consumers are recreated automatically by the client) | No filter configuration needed — ordered consumers are ephemeral |

### DLQ stream

| Requirement | What to configure externally |
|---|---|
| The stream's `subjects` list must contain exactly the DLQ stream name | The DLQ subject equals the stream name: e.g., if the stream is named `ext_dlq`, its subjects must include `ext_dlq` |

See [External DLQ](#external-dlq) below for a full example.

## Boot validation

At startup the binder performs the following checks. Failures are thrown as `JetstreamProvisioningError` (or a plain `Error` for logic violations); warnings are logged by the `Jetstream:Binder` logger.

### Throws (hard errors)

| Condition | Error message summary |
|---|---|
| Stream not found in NATS | `Management mode is Manual — the stream must be provisioned externally before boot.` |
| Consumer not found in NATS | `Management mode is Manual — the consumer must be provisioned externally before boot.` |
| Consumer filter does not cover one or more registered handler subjects | `Consumer "…" does not cover the following registered handler subjects: …. Update the consumer's filter_subject / filter_subjects to include them.` |
| DLQ stream subjects do not contain the DLQ subject | `DLQ stream "…" subjects do not cover "…" (dead letters publish to a subject equal to the stream name). Add it to the stream's subjects list.` |
| Scheduling is enabled (`allow_msg_schedules: true`) but stream subjects do not cover the schedule wildcard | `Stream "…" has scheduling enabled but its subjects do not cover the schedule prefix "…". Add "…>" to the stream's subjects.` |

### Warns (advisory)

| Condition | Warning message summary |
|---|---|
| Event or command stream retention is not `workqueue` | `Stream "…" retention is "…" — expected "workqueue" for reliable at-least-once delivery.` |
| Consumer has unlimited `max_deliver` but `dlq` is enabled | `Consumer "…" has unlimited max_deliver but options.dlq is enabled — messages will never be dead-lettered. Set max_deliver > 0 on the consumer.` |
| Consumer `ack_wait` is shorter than the computed `ackExtension` interval | `Consumer "…" ack_wait (…ms) is shorter than the ackExtension interval (…ms). Messages may redeliver before the handler finishes. Increase ack_wait.` |

### Boot summary

The startup log will list externally bound streams as `external (bound)` rows alongside the auto-provisioned ones, so you can confirm which entities the library touched:

```text
Provisioning 3 stream(s) for "orders":
  • ext_orders_stream [ev] external (bound)
  • broadcast-stream [broadcast] storage=file replicas=1
  • ext_dlq [dlq] external (bound)
  Σ per-node file-backed footprint ≈ 5.00 GiB
```

## Self-healing for Manual consumers

When the transport loses a consumer iterator (NATS reconnect, server restart, or external deletion), the self-healing loop tries to rebind. For a Manual consumer it **never recreates** it — if the consumer is absent it logs a recoverable error and keeps retrying on the same backoff schedule:

```text
Consumer ext_orders_worker on ext_orders_stream is externally managed and currently absent — waiting for it to be restored.
```

Once your platform team (or Terraform) restores the consumer, the next retry succeeds and processing resumes automatically. No application restart is needed.

This is the key difference from Auto mode: in Auto mode a missing consumer is silently recreated; in Manual mode the library waits, because recreating an externally owned resource would be a policy violation.

## External DLQ

When the DLQ stream itself is externally managed, configure it as follows:

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
    management: { stream: ManagementMode.Manual },
  },
})
```

The external DLQ stream must have the stream name itself in its subjects list. Create it with:

```bash
nats stream add ext_dlq \
  --subjects "ext_dlq" \
  --retention limits \
  --storage file \
  --replicas 1 \
  --defaults
```

The `dlq.management` field accepts only a `stream` override — there is no consumer to bind for the DLQ stream.

## Scheduling with a custom prefix

When `allow_msg_schedules: true` is set and a custom `subjectPrefix` is configured, schedule holders live under `{prefix}_sch.` rather than the default `{service}__microservice._sch.` prefix. The external stream **must** cover this prefix, otherwise boot fails:

```bash
# Stream must include the schedule wildcard alongside the regular subjects
nats stream add ext_orders_stream \
  --subjects "ext.orders.>,ext.orders._sch.>" \
  --retention workqueue \
  --storage file \
  --replicas 1 \
  --defaults
```

Or with a single wildcard that already covers both:

```bash
nats stream add ext_orders_stream \
  --subjects "ext.orders.>" \
  --retention workqueue \
  --storage file \
  --replicas 1 \
  --defaults
# "ext.orders.>" already covers "ext.orders._sch.>" — no extra entry needed
```

If the default naming convention is used (no `subjectPrefix`), the schedule wildcard is `{service}__microservice._sch.>` and must appear in the external stream's subjects.

## Interaction with allowDestructiveMigration

:::warning
Setting `allowDestructiveMigration: true` at the same time as a global `provisioning.management: Manual` is contradictory — Manual streams are never migrated regardless of the flag. The library logs a warning at boot:

```text
allowDestructiveMigration has no effect under provisioning.management: Manual — the library never migrates externally managed streams.
```
:::

The `allowDestructiveMigration` flag only applies to `Auto`-managed streams. See [Stream Migration](/docs/guides/stream-migration#manual-streams-are-never-migrated) for details.

## What's next?

- [**Stream Migration**](/docs/guides/stream-migration) — how the transport migrates Auto-managed streams
- [**Dead Letter Queue**](/docs/guides/dead-letter-queue) — DLQ stream configuration
- [**Scheduling**](/docs/guides/scheduling) — scheduled message delivery and the `_sch.` subject prefix
- [**Module Configuration**](/docs/reference/module-configuration) — full `management`, `subjectPrefix`, and custom name reference
