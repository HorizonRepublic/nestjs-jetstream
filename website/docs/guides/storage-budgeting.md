---
sidebar_position: 6
sidebar_label: "Storage budgeting"
title: "Storage budgeting & provisioning: NestJS JetStream"
description: "How JetStream stream reservations relate to the server max_file_store, and how to read the boot-time provisioning summary."
schema:
  type: Article
  headline: "Storage budgeting & provisioning"
  description: "How JetStream stream reservations relate to the server max_file_store, and how to read the boot-time provisioning summary."
  datePublished: "2026-06-02"
  dateModified: "2026-10-23"
---

# Storage budgeting & provisioning

> **Use when:** provisioning fails on storage, or you need to size a cluster before deploying.
> **You get:** the arithmetic behind stream reservations, the boot summary, and the pre-flight check.

Each stream the transport creates reserves storage up front, and the reservation is charged
against a budget shared by **every service** on the cluster.

## The arithmetic

A stream reserves `max_bytes` **per replica**:

```text
cluster reservation (one stream) = max_bytes × num_replicas
per-node footprint (your service) ~ Total max_bytes   (worst case: replicas = nodes)
```

On a 3-node cluster with `num_replicas: 3`, every stream keeps a replica on every node, so each
node must hold the **sum of `max_bytes`** across all your streams. A stream exists only for a kind
with registered handlers. With the [library defaults](/docs/reference/default-configs#stream-defaults),
a service with event, broadcast and ordered handlers reserves event 512 MiB + broadcast 256 MiB +
ordered 1 GiB + DLQ 256 MiB = 2 GiB **per node**. JetStream-mode RPC adds a 64 MiB command stream,
and recurring schedules a 64 MiB schedule stream.

The NATS server's `max_file_store` is a **per-node** ceiling shared by all services. Provisioning
fails when the sum of reservations across every service exceeds it.

## The boot summary

On startup the transport logs a summary at `INFO` (always on):

```text
Provisioning 3 stream(s) for "orders":
  - orders__microservice_ev-stream [ev] storage=file replicas=3 max_bytes=0.50 GiB max_age=7.0d retention=workqueue -> cluster reservation 1.50 GiB
  - broadcast-stream [broadcast] storage=file replicas=3 max_bytes=0.25 GiB max_age=1.0h retention=limits -> cluster reservation 0.75 GiB
  - orders__microservice_dlq-stream [dlq] storage=file replicas=3 max_bytes=0.25 GiB max_age=30.0d retention=limits -> cluster reservation 0.75 GiB
  Total per-node file-backed footprint ~ 1.00 GiB (sum of max_bytes; worst case replicas = nodes). Ensure the NATS server max_file_store accommodates the sum across ALL services.
```

Read the `Total per-node file-backed footprint` line first: that is what each node must hold for
this service alone. Memory-backed streams are left out of it.

## When provisioning fails

A stream that cannot be created throws a `JetstreamProvisioningError` carrying the stream name,
the requested `max_bytes` and `num_replicas`, the reservation, the NATS `err_code` and description,
and a remediation hint. Two common cases:

- **Insufficient storage**: the aggregate reservation exceeds `max_file_store`. Lower
  `max_bytes`/`num_replicas` for the service, or raise `max_file_store` on the servers.
- **No suitable peers**: fewer healthy peers than `num_replicas`, or no peer with enough
  headroom. Reduce replicas or add/repair nodes.

## Opt-in pre-flight check

With `provisioning.preflightStorageCheck: true` the transport reads the account limits via
`getAccountInfo()` before provisioning and **warns** (never throws) when this service's reservation
would exceed the remaining budget:

```ts
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  provisioning: { preflightStorageCheck: true },
});
```

This is a best-effort heuristic:

- The server-side `max_file_store` is not exposed to clients. If the account has no explicit
  `max_storage` limit, the check logs that it cannot verify the real ceiling.
- Account info is an aggregate, not per-node, so a cluster with skewed placement can still fail.
- It is subject to a check-then-act race with other services.

Setting an **account-level** `max_storage` (besides, or instead of, the server
`max_file_store`) makes the pre-flight accurate and admission control predictable. Either way, the
`JetstreamProvisioningError` on the actual failure remains the source of truth.
