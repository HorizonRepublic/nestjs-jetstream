---
sidebar_position: 6
sidebar_label: "Storage budgeting"
title: "Storage budgeting & provisioning — NestJS JetStream"
description: "How JetStream stream reservations relate to the server max_file_store, and how to read the boot-time provisioning summary."
schema:
  type: Article
  headline: "Storage budgeting & provisioning"
  description: "How JetStream stream reservations relate to the server max_file_store, and how to read the boot-time provisioning summary."
  datePublished: "2026-06-02"
  dateModified: "2026-06-02"
---

# Storage budgeting & provisioning

When your service starts, the transport ensures its JetStream streams exist. Each stream
reserves storage up front, and that reservation is charged against a budget shared by **every
service** on the cluster. This page explains the arithmetic and how to read the boot summary.

## The arithmetic

A stream reserves `max_bytes` **per replica**:

```
cluster reservation (one stream) = max_bytes × num_replicas
per-node footprint (your service) ≈ Σ max_bytes   (worst case: replicas = nodes)
```

On a 3-node cluster with `num_replicas: 3`, every stream keeps a replica on every node, so each
node must hold the **sum of `max_bytes`** across all your streams. With the library defaults
(event 5 GiB + broadcast 2 GiB + ordered 5 GiB + DLQ 5 GiB) that is ~17 GiB **per node**.

The NATS server's `max_file_store` is a **per-node** ceiling shared by all services. Provisioning
fails when the sum of reservations across every service exceeds it.

## The boot summary

On startup the transport logs a summary at `INFO` (always on):

```
Provisioning 2 stream(s) for "orders":
  • orders__microservice_ev-stream [ev] storage=file replicas=3 max_bytes=5.00 GiB max_age=7.0d retention=workqueue → cluster reservation 15.00 GiB
  • broadcast-stream [broadcast] storage=file replicas=3 max_bytes=2.00 GiB max_age=1.0h retention=limits → cluster reservation 6.00 GiB
  Σ per-node footprint ≈ 7.00 GiB (sum of max_bytes; worst case replicas = nodes). Ensure the NATS server max_file_store accommodates the sum across ALL services.
```

Read the `Σ per-node footprint` line first: that is what each node must accommodate from this
service alone.

## When provisioning fails

If a stream cannot be created, the transport throws a `JetstreamProvisioningError` with the
stream name, the requested `max_bytes`/`num_replicas`, the reservation, the NATS `err_code` and
description, and a remediation hint — instead of crashing with an opaque API error. Two common
cases:

- **Insufficient storage** — the aggregate reservation exceeds `max_file_store`. Lower
  `max_bytes`/`num_replicas` for the service, or raise `max_file_store` on the servers.
- **No suitable peers** — fewer healthy peers than `num_replicas`, or no peer with enough
  headroom. Reduce replicas or add/repair nodes.

## Opt-in pre-flight check

Set `provisioning.preflightStorageCheck: true` to have the transport query account limits via
`getAccountInfo()` before provisioning and **warn** when this service's reservation would exceed
the remaining budget:

```ts
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  provisioning: { preflightStorageCheck: true },
});
```

This is a best-effort heuristic, not a guarantee:

- The server-side `max_file_store` is **not** exposed to clients. If the account has no explicit
  `max_storage` limit, the check logs that it cannot verify the real ceiling.
- Account info is an aggregate, not per-node, so a cluster with skewed placement can still fail.
- It is subject to a check-then-act race with other services.

Setting an **account-level** `max_storage` (in addition to, or instead of, the server
`max_file_store`) makes the pre-flight accurate and admission control predictable. Either way, the
`JetstreamProvisioningError` on the actual failure remains the source of truth.
