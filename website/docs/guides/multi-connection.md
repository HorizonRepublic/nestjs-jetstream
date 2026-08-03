---
sidebar_position: 5
sidebar_label: "Multiple connections"
title: "Multiple NATS connections in one NestJS service"
description: "Connect one NestJS service to several NATS clusters with named connections: per-cluster handlers and clients, critical versus degradable connections, health, and shutdown."
schema:
  type: Article
  headline: "Multiple NATS connections in one NestJS service"
  description: "Named NATS connections in NestJS JetStream: configuration, handler binding, criticality, health, and shutdown."
  datePublished: "2026-08-03"
  dateModified: "2026-08-03"
---

import Since from '@site/src/components/Since';

# Multiple NATS connections in one service

<Since version="3.0" />

One service, several NATS clusters. Each connection has its own streams, consumers, routers and backpressure budget; handlers and clients declare which one they belong to.

Typical reasons to reach for this:

- **Traffic isolation.** Business events on the primary cluster, audit or analytics firehose on a separate one, so a flood in the latter cannot starve the former.
- **Cross-DC bridging.** A service that consumes locally and publishes to a remote region.
- **Cluster migration.** Run handlers against the old and new cluster side by side, then drop the old connection.

If you only need one cluster, change nothing: the flat `servers` form is still the whole story.

## Configuration

Replace `servers` with a `connections` map. The two forms are mutually exclusive — supplying both fails at startup.

```typescript
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'orders',
      defaultConnection: 'primary',
      connections: {
        primary: { servers: ['nats://primary:4222'] },
        analytics: {
          servers: ['nats://analytics:4222'],
          critical: false,
        },
      },
    }),
  ],
})
export class AppModule {}
```

`defaultConnection` names the connection that unqualified handlers and clients bind to. It is optional when a key is literally `default`, or when there is only one connection. With several connections and no `default` key it is required — the transport will not guess.

### Inheritance

Connection options merge over root options one level deep. Set something once at the root and it applies everywhere; name the same option on a connection and that connection wins.

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  defaultConnection: 'primary',
  events: { concurrency: 4 },          // applies to both connections
  connections: {
    primary: { servers: ['nats://primary:4222'] },
    analytics: {
      servers: ['nats://analytics:4222'],
      events: { concurrency: 32 },     // wins for analytics only
      provisioning: { management: ManagementMode.Manual },
    },
  },
})
```

Every per-cluster knob is tunable this way: `events`, `broadcast`, `ordered`, `rpc`, `dlq`, `metadata`, `provisioning`, `allowDestructiveMigration`, `shutdownTimeout`, `codec`, `connectionOptions`, and `consumer: false` for a publish-only connection.

:::warning A block you redeclare replaces the root one entirely
The merge is one level deep, so naming `events` on a connection replaces the whole root `events` block rather than merging into it. In the example above, `analytics` gets `concurrency: 32` and **loses** any `events.retry` or `events.stream` set at the root. Repeat the parts you still want:

```typescript
events: { concurrency: 32, retry: rootRetry },   // on the connection
```

The same applies to `broadcast`, `ordered`, `rpc`, `dlq`, `metadata`, `provisioning` and `connectionOptions`.
:::

**Root-only fields.** `name`, `hooks`, `metrics`, `otel` and `onDeadLetter` stay at the root. They describe or observe the service as a whole, so a connection never overrides them.

## Binding handlers

Three levels, weakest to strongest: the default connection, a class decorator, a method-level override.

```typescript
import { JetstreamConnection } from '@horizon-republic/nestjs-jetstream';

@Controller()
export class OrdersController {
  @EventPattern('order.created')     // default connection
  handleOrder(@Payload() data: OrderCreated) {}
}

@JetstreamConnection('analytics')
@Controller()
export class AnalyticsController {
  @EventPattern('page.viewed')       // analytics connection
  handleView(@Payload() data: PageView) {}

  @EventPattern('audit.written', { connection: 'primary' })
  handleAudit(@Payload() data: AuditEntry) {}   // method wins over the class
}
```

A controller usually belongs to one cluster, so the class decorator is the common case; the method-level `{ connection }` extra is there for the exceptions.

**Typos fail at startup.** Naming a connection that is not configured — or one declared `consumer: false` — raises at bootstrap with the list of configured names, rather than silently routing to the default connection and surfacing in production.

The same pattern may exist on two connections. That is a legitimate migration scenario, not a duplicate; the duplicate-handler check applies within a connection.

## Publishing

`forFeature()` takes an optional `connection`:

```typescript
@Module({
  imports: [
    JetstreamModule.forFeature({ name: 'payments' }),                          // default
    JetstreamModule.forFeature({ name: 'warehouse', connection: 'analytics' }), // named
  ],
})
export class OrdersModule {}
```

Inject them with the matching token:

```typescript
constructor(
  @Inject(getClientToken('payments')) private readonly payments: ClientProxy,
  @Inject(getClientToken('warehouse', 'analytics')) private readonly warehouse: ClientProxy,
) {}
```

`getClientToken(name)` returns exactly what it always did, so existing injections are untouched.

## Bootstrap

A multi-connection application is a hybrid application: one NestJS microservice per connection. `connectJetstreamMicroservices()` attaches them all.

```typescript
import { connectJetstreamMicroservices } from '@horizon-republic/nestjs-jetstream';

const app = await NestFactory.create(AppModule);

connectJetstreamMicroservices(app);
await app.startAllMicroservices();
await app.listen(3000);
```

:::warning Configuring a second connection is not enough
If you add a connection but keep the old single-strategy bootstrap, that connection's handlers are registered and never subscribed — no error, just events quietly not processed. The transport therefore fails at startup naming the connections the bootstrap skipped. Single-connection applications are unaffected.
:::

The check is on attachment, not on readiness: a connection that was attached but is still connecting is fine, which is what makes `critical: false` work. If your bootstrap calls `app.init()` before `app.startAllMicroservices()`, nothing is attached yet when the check runs, so it logs a warning instead of failing.

Publisher-only connections have no strategy and are skipped automatically.

## Criticality

`critical` decides whether the application's startup depends on a connection.

|                      | `critical: true` (default)            | `critical: false`                               |
| -------------------- | ------------------------------------- | ----------------------------------------------- |
| Boot                 | Blocks until the cluster is reachable | Returns immediately, connects in the background |
| Cluster down at boot | Startup fails                         | Startup succeeds                                |
| Retry                | —                                     | Exponential backoff, capped at 30 s             |
| Health               | `connected: false`                    | `degraded: true`, readiness unaffected          |

A dead analytics cluster must not stop the pod that serves the primary one. That is the whole point of `critical: false`.

Because a connection with no handlers never touches NATS on its own, every critical connection is opened explicitly during bootstrap — otherwise the flag would have no effect on a publish-only connection, which is precisely the case it exists for.

## Health

`check()` gains two fields once more than one connection is configured:

```json
{
  "connected": true,
  "server": "nats://primary:4222",
  "latency": 1,
  "degraded": true,
  "connections": {
    "primary":   { "connected": true,  "critical": true,  "server": "nats://primary:4222", "latency": 1 },
    "analytics": { "connected": false, "critical": false, "server": null, "latency": null }
  }
}
```

- `connected` means **every critical connection is alive**. `isHealthy()` throws only when this is false.
- `degraded` means **at least one non-critical connection is down**. It is orthogonal to `connected`.
- `server` and `latency` describe the default connection, so the old fields keep their meaning.

With a single connection, `degraded` and `connections` are absent and the response is byte-for-byte what it was before.

**Readiness watches critical connections; liveness watches the process.** Do not wire a liveness probe to NATS — a network blip then restarts the pod at exactly the moment the transport is recovering, turning a hiccup into a cascade.

## Shutdown

Draining connections one at a time has a bug: while the first drains, the others keep accepting work. Shutdown therefore runs in two phases.

1. Every connection stops accepting new messages.
2. Every connection drains in parallel, each bounded by its own `shutdownTimeout`.

The ceiling for the whole SIGTERM is `max(timeouts)`, not their sum. A connection that throws while draining does not stop the others from closing.

## Hooks and metrics

Hooks are registered once, at the root, and fire for every connection. Each callback receives the originating connection name as a trailing argument when more than one connection is configured:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  hooks: {
    [TransportEvent.Error]: (error, context, connection) => {
      sentry.captureException(error, { tags: { connection } });
    },
  },
  connections: { /* ... */ },
})
```

Single-connection applications receive the exact payloads they always did.

Prometheus metrics aggregate across connections and carry no `connection` label. That is the right default for "how much traffic did this service process", but it means a per-connection breakdown is not available from metrics today.

## Naming and collisions

Stream, consumer and subject names **do not change** when you add connections. Renaming would orphan existing streams and strand their messages.

The flip side is that two connections into one cluster would resolve identical stream names and silently overwrite each other's configuration. Two checks prevent that:

1. **Config level, before any network call.** Two connections with an identical server set (normalized for order and default port) fail at startup. Only connections that provision infrastructure are compared, so a `consumer: false` connection may share a cluster with another one.
2. **NATS level.** Each provisioned stream carries a `nestjs-jetstream-owner` metadata stamp of `{service}:{connection}`, the dead-letter stream included. A stream already stamped by a different connection of the same service fails provisioning, naming both connections. Two connections racing to create the same stream are caught the same way: the one that loses the race re-reads the stream and reports the conflict.

The shared broadcast stream is exempt from the stamp — every service in the cluster shares it, so a per-connection stamp would flip-flop on each deploy. Metadata written by anyone else is carried forward on update rather than replaced, so operator-set keys and a `metadata` block in your own stream overrides both survive.

Under `provisioning: { management: ManagementMode.Manual }` the streams are externally owned, so nothing is stamped and the second check does not apply. The first still does.

## Out of scope

- **Cross-connection RPC.** The reply inbox lives on the connection that sent the request; bridging it makes timeouts meaningless. Cross-cluster routing belongs to a NATS leafnode or gateway.
- **Per-connection hooks or event bus.** One bus, tagged events.
- **Automatic failover between connections.**
- **Cross-connection transactional publish.** Publishing to two clusters is two independent operations; a failure between them leaves partial state.

## See also

- [Module Configuration](/docs/reference/module-configuration): full options reference
- [Health Checks](/docs/guides/health-checks): readiness, liveness and degraded state
- [Graceful Shutdown](/docs/guides/graceful-shutdown): drain behaviour and timeouts
- [Bring Your Own Infrastructure](/docs/guides/external-infrastructure): per-connection provisioning modes
- [Naming Conventions](/docs/reference/naming-conventions): how stream and subject names are derived
