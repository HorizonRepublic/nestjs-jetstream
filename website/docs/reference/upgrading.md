---
sidebar_label: "Upgrading"
title: "Upgrading NestJS JetStream between major versions"
description: "What changes when you upgrade @horizon-republic/nestjs-jetstream, release by release: renamed options, changed defaults, and how to keep the previous behaviour."
schema:
  type: Article
  headline: "Upgrading NestJS JetStream between major versions"
  description: "Renamed options, changed defaults and how to keep the previous behaviour, release by release."
  datePublished: "2026-10-23"
  dateModified: "2026-10-23"
---

# Upgrading

> **Use when:** you already run this library and are bumping its version.
> **You get:** what changes for you, release by release, and how to restore the previous behaviour.

Newest first. What each release adds is in the [release notes](/docs/reference/release-notes); this page lists only what you may have to act on.

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
