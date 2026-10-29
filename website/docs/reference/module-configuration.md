---
sidebar_position: 1
sidebar_label: "Module Configuration"
title: "Module Configuration: NestJS JetStream Transport"
description: "Reference for forRoot(), forRootAsync(), and forFeature() registration methods, plus stream, consumer, RPC, and connection options."
schema:
  type: Article
  headline: "Module Configuration Reference"
  description: "Reference for forRoot(), forRootAsync(), and forFeature() registration methods with stream, consumer, and connection options."
  datePublished: "2026-03-21"
  dateModified: "2026-10-29"
---

# Module Configuration

> **Use when:** you are looking up a specific option or its default.
> **You get:** every key `forRoot()`, `forRootAsync()` and `forFeature()` accept, with type and default.

For a guided introduction see the [Quick Start](/docs/getting-started/quick-start).

## forRoot()

`forRoot()` registers the transport globally. Call it **once** in your root `AppModule`. It creates the shared NATS connection, codec and event bus, and, unless `publisherOnly` is set, the streams and consumers.

```typescript title="src/app.module.ts"
import { Module } from '@nestjs/common';
import { JetstreamModule, TransportEvent, toNanos } from '@horizon-republic/nestjs-jetstream';

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'user-events',
      servers: ['nats://localhost:4222'],
      events: {
        stream: {
          max_age: toNanos(30, 'days'),
          max_bytes: 10 * 1024 * 1024 * 1024, // 10 GB
          num_replicas: 3,
        },
        consumer: {
          max_ack_pending: 500,
          ack_wait: toNanos(30, 'seconds'),
        },
        consume: { idle_heartbeat: 10_000 },
        concurrency: 200,
        ackExtension: true,
      },
      rpc: { mode: 'core', timeout: 10_000 },
      shutdownTimeout: 15_000,
      hooks: {
        [TransportEvent.Error]: (err, ctx) => console.error(`[${ctx}]`, err),
        [TransportEvent.Connect]: (server) => console.log(`Connected to ${server}`),
      },
    }),
  ],
})
export class AppModule {}
```

### How `name` maps to streams and subjects

Given `name: 'user-events'`, the event stream is `user-events__microservice_ev-stream`, its subjects are `user-events__microservice.ev.{pattern}` and its consumer is `user-events__microservice_ev-consumer`. The `__microservice` suffix keeps these apart from other NATS clients on the cluster. [Naming Conventions](/docs/reference/naming-conventions) has the full table for every kind.

## forRootAsync()

Use `forRootAsync()` to load the options from environment variables or a config service. It supports three patterns.

### useFactory (most common)

```typescript title="src/app.module.ts"
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';

@Module({
  imports: [
    ConfigModule.forRoot(),
    JetstreamModule.forRootAsync({
      name: 'orders',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const mode = config.get<'core' | 'jetstream'>('RPC_MODE', 'core');

        return {
          servers: [config.getOrThrow('NATS_URL')],
          rpc: mode === 'jetstream' ? { mode, timeout: 60_000 } : { mode },
          shutdownTimeout: config.get('SHUTDOWN_TIMEOUT', 10_000),
        };
      },
    }),
  ],
})
export class AppModule {}
```

:::note The `name` lives outside the factory
`name` sits at the top level of `forRootAsync()`, not in the factory's return value: DI token generation needs it before the factory runs. `imports` is optional in all three patterns.
:::

### useExisting

Reuse a provider that is already registered:

```typescript
JetstreamModule.forRootAsync({
  name: 'orders',
  imports: [NatsConfigModule],
  useExisting: NatsConfigService,
})
```

`NatsConfigService` must implement `Omit<JetstreamModuleOptions, 'name'>` directly: the instance itself is the options object, no factory method is called on it.

### useClass

Like `useExisting`, but the module instantiates the class:

```typescript
JetstreamModule.forRootAsync({
  name: 'orders',
  useClass: NatsConfigService,
})
```

## forFeature()

`forFeature()` creates a `JetstreamClient` for a target service on the connection `forRoot()` opened. Import it in each feature module that talks to that service:

```typescript title="src/orders/orders.module.ts"
import { Module } from '@nestjs/common';
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';
import { OrdersService } from './orders.service';

@Module({
  imports: [
    JetstreamModule.forFeature({ name: 'users' }),
    JetstreamModule.forFeature({ name: 'payments' }),
  ],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
```

### Injecting clients

The injection token is the `name` you passed to `forFeature()`:

```typescript title="src/orders/orders.service.ts"
import { Injectable, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class OrdersService {
  constructor(@Inject('users') private readonly usersClient: ClientProxy) {}

  getUser(id: number) {
    return firstValueFrom(this.usersClient.send('user.get', { id }));
  }
}
```

`getClientToken(name)` returns the same string. A client bound to a named connection (`forFeature({ name, connection })`) has a namespaced token instead: inject it with `getClientToken(name, connection)`. See [Multiple connections](/docs/guides/multi-connection).

### forFeature() options

| Option          | Type                    | Default                | What it does                                                                              |
| --------------- | ----------------------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| `name`          | `string`                | required               | Target service name. Subjects are built from it.                                          |
| `connection`    | `string`                | the default connection | Connection the client publishes on.                                                       |
| `codec`         | `Codec`                 | the `forRoot()` codec  | Per-client codec override.                                                                |
| `subjectPrefix` | `TargetSubjectPrefixes` | the naming convention  | The target's custom subject prefixes. See [below](#targets-with-a-custom-subject-prefix). |

### Per-client codec override

A client falls back to the `forRoot()` codec unless you pass its own:

```typescript
import { MsgPackCodec } from './codecs/msgpack.codec';

JetstreamModule.forFeature({
  name: 'legacy-service',
  codec: new MsgPackCodec(),
})
```

See [Custom Codec](/docs/guides/custom-codec) for how to implement the `Codec` interface.

### Targets with a custom subject prefix

A client builds the target's subjects from the naming convention. When the target sets `subjectPrefix` on `events`, `ordered` or `rpc`, repeat those values in `forFeature()`, or the client publishes where nothing listens:

```typescript
// The asset service
JetstreamModule.forRoot({
  name: 'asset',
  servers,
  rpc: { mode: 'jetstream', subjectPrefix: 'acme.rpc.asset' },
  events: { subjectPrefix: 'acme.ev.asset' },
});

// Any service that calls it
JetstreamModule.forFeature({
  name: 'asset',
  subjectPrefix: { rpc: 'acme.rpc.asset', events: 'acme.ev.asset' },
});
```

| Key        | Mirrors the target's     |
| ---------- | ------------------------ |
| `events`   | `events.subjectPrefix`   |
| `ordered`  | `ordered.subjectPrefix`  |
| `rpc`      | `rpc.subjectPrefix`      |
| `schedule` | `schedule.subjectPrefix` |

Kinds you leave out keep the convention. Delayed events follow the prefix too, so `scheduleAt()` lands in the target's `{prefix}_sch.` namespace, and `client.schedule()` writes its holder under the target's `{prefix}_cron.`. Broadcast has no key: it is one stream shared by every service and follows the caller's own `broadcast.subjectPrefix`.

Prefixes are validated when the client is created, with the same rules as `forRoot()`. Passing `subjectPrefix` to a client that targets the service itself fails at startup, because its own prefixes already come from `forRoot()`.

## Full options reference

Every field in `JetstreamModuleOptions`. Blocks that need more than a line have their own section below.

### Root options

| Option              | Type                                         | Default                | What it does                                                                                                                      |
| ------------------- | -------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`              | `string`                                     | required               | Drives stream, consumer and subject naming. Unique per service.                                                                   |
| `servers`           | `string[]`                                   | none                   | NATS server URLs. Required unless you use `connections`, and supplying both fails at startup.                                     |
| `connections`       | `Record<string, JetstreamConnectionOptions>` | none                   | One entry per NATS cluster, mutually exclusive with `servers`. See [connections](#connections).                                   |
| `defaultConnection` | `string`                                     | none                   | Which connection unqualified handlers and clients bind to.                                                                        |
| `codec`             | `Codec`                                      | `JsonCodec`            | Message serializer. See [Custom Codec](/docs/guides/custom-codec).                                                                |
| `publisherOnly`     | `boolean`                                    | `false`                | `true` skips every stream, consumer and route. See [publisher-only mode](#publisher-only-mode).                                   |
| `rpc`               | `RpcConfig`                                  | `{ mode: 'core' }`     | RPC transport mode. See [RpcConfig](#rpcconfig).                                                                                  |
| `events`            | `StreamConsumerOverrides`                    | production defaults    | Workqueue event stream and consumer. See [StreamConsumerOverrides](#streamconsumeroverrides).                                     |
| `broadcast`         | `StreamConsumerOverrides`                    | production defaults    | Broadcast event stream and consumer, same shape as `events`.                                                                      |
| `schedule`          | `StreamConsumerOverrides`                    | production defaults    | [Recurring schedules](/docs/guides/recurring-schedules) stream and consumer, same shape as `events`.                              |
| `ordered`           | `OrderedEventOverrides`                      | production defaults    | Ordered event consumers. See [OrderedEventOverrides](#orderedeventoverrides).                                                     |
| `dlq`               | `DlqOptions \| boolean`                      | enabled                | Republishes exhausted messages to a dedicated stream. See [dlq](#dlq).                                                            |
| `onDeadLetter`      | `(info: DeadLetterInfo) => Promise<void>`    | none                   | Awaited before `term()` when a message exhausts every delivery attempt. If it throws, the message is naked.                       |
| `hooks`             | `Partial<TransportHooks>`                    | none                   | Lifecycle hook handlers. Unset hooks are ignored in silence.                                                                      |
| `metrics`           | `MetricsOption`                              | none                   | Prometheus metrics. `true` for defaults, or a `MetricsConfig`. See [Metrics](/docs/observability/metrics).                        |
| `otel`              | `OtelOptions \| boolean`                     | enabled                | OpenTelemetry tracing, a no-op without an SDK. `false` turns it off. See [Tracing](/docs/observability/tracing).                  |
| `metadata`          | `MetadataRegistryOptions`                    | auto                   | Handler metadata in NATS KV, on when any handler has `meta`. No-op under `publisherOnly`. See [metadata](#metadata).              |
| `provisioning`      | `ProvisioningOptions`                        | `{ management: Auto }` | Who owns streams and consumers. See [provisioning](#provisioning).                                                                |
| `shutdownTimeout`   | `number`                                     | `10_000`               | Drain budget in milliseconds. The connection is closed when it runs out. See [Graceful Shutdown](/docs/guides/graceful-shutdown). |
| `connectionOptions` | `Partial<ConnectionOptions>`                 | none                   | Raw NATS options for TLS, auth and reconnection. See [connectionOptions](#connectionoptions).                                     |

`name`, `hooks`, `metrics`, `otel` and `onDeadLetter` stay at the root even when you use `connections`: they describe or observe the service as a whole.

### connections

Each entry inherits every root field it does not name, and may override `critical`, `publisherOnly`, `codec`, `connectionOptions`, `events`, `broadcast`, `schedule`, `ordered`, `rpc`, `dlq`, `metadata`, `provisioning` and `shutdownTimeout`.

`critical` defaults to `true`. A `false` connection connects lazily in the background, retrying with exponential backoff capped at 30 s. It reports `degraded` health instead of failing readiness.

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  defaultConnection: 'primary',
  events: { concurrency: 4 },        // inherited by both
  connections: {
    primary: { servers: ['nats://primary:4222'] },
    analytics: {
      servers: ['nats://analytics:4222'],
      critical: false,               // startup does not depend on it
      events: { concurrency: 32 },   // overrides the root value
    },
  },
})
```

:::warning The merge is one level deep
Naming a block such as `events` replaces the root block entirely instead of merging into it. Above, `analytics` gets `concurrency: 32` and loses any other `events` key set at the root. Repeat the parts you still want.
:::

`defaultConnection` is optional when the map has a `default` key, and required otherwise. See [Multiple connections](/docs/guides/multi-connection).

### dlq

Exhausted messages are republished to a dedicated DLQ stream with tracking headers. Pass `true` for the defaults, or `false` to turn it off and leave them where they land.

| Field        | Type                    | Default                                              | What it does                                                                                 |
| ------------ | ----------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `stream`     | `StreamConfigOverrides` | [DLQ defaults](/docs/reference/default-configs)      | Stream overrides, `name` included.                                                           |
| `management` | `ManagementMode`        | falls back to `provisioning.management`, then `Auto` | `Auto` provisions the stream, `Manual` binds to an existing one. The stream has no consumer. |

See [Built-in DLQ stream](/docs/guides/dead-letter-queue#built-in-dlq-stream) and [External DLQ](/docs/guides/external-infrastructure#external-dlq).

:::note Bind-only deployments
Under `provisioning: { management: Manual }` the implicit default stands down, since a service that provisions nothing should not fail boot over a stream nobody asked for. Set `dlq` explicitly to bind to an externally provisioned one.
:::

### retry

`readonly number[] | false`, default `[2000, 10000, 30000, 60000]`, set per kind on `events`, `broadcast` and `schedule`. Delay in milliseconds before each redelivery after a handler throws or calls `ctx.retry()`. Index 0 is the first retry, and the last entry repeats once the curve runs out. `false` naks immediately, which burns every attempt as fast as the handler can fail.

The delays are applied client-side when the message is naked, not through the consumer's `backoff`, so `ack_wait` keeps its configured value.

Keep `max_deliver` at one more than the number of delays, so every delay is used once before the message is dead-lettered. Size the curve to the longest outage you want to ride out without touching the DLQ:

| Outage to ride out | `max_deliver` | `retry`                                                                                           |
| ------------------ | ------------- | ------------------------------------------------------------------------------------------------- |
| ~100 s (default)   | `5`           | `[2_000, 10_000, 30_000, 60_000]`                                                                 |
| ~10 minutes        | `8`           | `[2_000, 10_000, 30_000, 60_000, 120_000, 180_000, 240_000]`                                      |
| ~1 hour            | `12`          | `[5_000, 30_000, 60_000, 120_000, 300_000, 300_000, 600_000, 600_000, 600_000, 600_000, 600_000]` |

```typescript
events: {
  consumer: { max_deliver: 8 },
  retry: [2_000, 10_000, 30_000, 60_000, 120_000, 180_000, 240_000],
}
```

A message waiting out its delay keeps its slot in `max_ack_pending` (100 by default), so a long curve has a cost: when a dependency is down and every message fails, the consumer holds 100 delayed messages and takes nothing new until their delays run out. That is harmless during a full outage, since nothing would succeed anyway, but with many messages no retry can fix, they crowd out healthy ones for as long as the curve lasts. Raise `max_ack_pending` alongside a long curve.

### metadata

| Field      | Type     | Default              | What it does                                                                                 |
| ---------- | -------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `bucket`   | `string` | `'handler_registry'` | KV bucket name.                                                                              |
| `replicas` | `number` | `1`                  | Bucket replicas, an odd number no larger than the cluster.                                   |
| `ttl`      | `number` | `30_000`             | Entry TTL in milliseconds, at least `5_000`. Each pod refreshes its entries every `ttl / 2`. |

See [Handler Metadata](/docs/patterns/handler-metadata).

### provisioning

| Field                       | Type             | Default               | What it does                                                                                                                                                                                                             |
| --------------------------- | ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `management`                | `ManagementMode` | `ManagementMode.Auto` | `Auto` creates and updates every entity. `Manual` binds to existing ones and fails at boot if any are absent.                                                                                                            |
| `preflightStorageCheck`     | `boolean`        | `false`               | Calls `getAccountInfo()` before provisioning and warns if the streams would not fit the account budget. Never blocks boot.                                                                                               |
| `allowDestructiveMigration` | `boolean`        | `false`               | Recreates a stream through blue-green sourcing when an immutable property such as `storage` changes. Off, the conflict is logged and the stream keeps its config. See [Stream Migration](/docs/guides/stream-migration). |

Override `management` per entity through `events.management`, `broadcast.management` and so on. `retention` is never migrated: the kind decides it, and a mismatch is always an error. Resolution order is per-entity, then global, then `Auto`. See [Bring Your Own Infrastructure](/docs/guides/external-infrastructure).

### RpcConfig

A discriminated union on `mode`. Pick by whether commands must survive handler downtime.

| `mode`        | Persistence                        | Default timeout   | Best for                                                           |
| ------------- | ---------------------------------- | ----------------- | ------------------------------------------------------------------ |
| `'core'`      | none, NATS native request/reply    | `30_000` (30 s)   | Low-latency queries and lookups where in-flight requests can error |
| `'jetstream'` | commands persisted before delivery | `180_000` (3 min) | Commands that must survive a handler restart (payments, state)     |

```typescript
// Core mode (default) -- NATS native request/reply
rpc: { mode: 'core', timeout: 10_000 }

// JetStream mode -- commands persisted in a stream
rpc: {
  mode: 'jetstream',
  timeout: 60_000,
  stream: { max_age: toNanos(1, 'minutes') },     // stream overrides
  consumer: { max_deliver: 3 },            // consumer overrides
}
```

The `'jetstream'` variant is `StreamConsumerOverrides` plus `mode` and `timeout`, so `stream`, `consumer`, `consume`, `concurrency`, `ackExtension`, `management` and `subjectPrefix` all mean what they mean elsewhere. `retry` is absent: a command is delivered once.

:::note Timeout is milliseconds, and applies to both sides
Writing `timeout: 30` means 30 ms, which is a bug in almost every case. Use `timeout: 30_000` for 30 seconds. The value bounds both the caller's wait and the handler's run, each side reading it from its own `forRoot()`.
:::

See [RPC Patterns](/docs/patterns/rpc) for a full comparison of the two modes.

### StreamConsumerOverrides

Accepted by `events`, `broadcast`, `schedule` and the `'jetstream'` variant of `rpc`. Overrides merge with the [production defaults](/docs/reference/default-configs), so name only what you want to change.

| Field                   | Type                         | Default                                              | What it does                                                                                                                                                                                                                                |
| ----------------------- | ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream`                | `StreamConfigOverrides`      | production defaults                                  | Stream overrides such as `max_age` and `max_bytes`. `retention`, `subjects` and `description` are owned by the transport and not settable.                                                                                                  |
| `consumer`              | `Partial<ConsumerConfig>`    | production defaults                                  | Consumer overrides such as `max_deliver` and `ack_wait`.                                                                                                                                                                                    |
| `consume`               | `Partial<ConsumeOptions>`    | nats.js defaults                                     | Options for nats.js `consume()`: prefetch, `idle_heartbeat`, refill thresholds. Do not mix the message-based and byte-based thresholds.                                                                                                     |
| `concurrency`           | `number`                     | unlimited, bounded by `max_ack_pending`              | Handler executions in flight at once; the rest queue FIFO. Below `max_ack_pending`, raise `ack_wait` too, since queued messages' ack timers keep running.                                                                                   |
| `ackExtension`          | `AckExtensionConfig`         | `false`                                              | Extends the ack deadline with `msg.working()` while a handler runs: `true` every `ack_wait / 2`, a number every that many milliseconds, `{ interval?, maxDuration? }` with a per-message limit. Extension stops after 5 minutes by default. |
| `retry`                 | `readonly number[] \| false` | `[2000, 10000, 30000, 60000]`                        | Redelivery curve. See [retry](#retry). Not on `rpc`.                                                                                                                                                                                        |
| `stream.name`           | `string`                     | `{service}__microservice_ev-stream` and friends      | Bind to an externally provisioned stream with a custom name.                                                                                                                                                                                |
| `consumer.durable_name` | `string`                     | `{service}__microservice_ev-consumer` and friends    | Bind to an externally provisioned consumer.                                                                                                                                                                                                 |
| `management`            | `EntityManagement`           | falls back to `provisioning.management`, then `Auto` | Per-kind control, with separate `stream` and `consumer` entries.                                                                                                                                                                            |
| `subjectPrefix`         | `string`                     | `{service}__microservice.ev.` and friends            | Custom subject prefix. The trailing dot is normalized.                                                                                                                                                                                      |

```typescript
import { ManagementMode, toNanos } from '@horizon-republic/nestjs-jetstream';

events: {
  stream: { max_age: toNanos(3, 'days'), name: 'platform_orders_stream' },
  consumer: { max_deliver: 5, ack_wait: toNanos(30, 'seconds') },
  management: { stream: ManagementMode.Manual, consumer: ManagementMode.Auto },
  subjectPrefix: 'company.orders.',   // publishes to company.orders.{pattern}
}
```

A custom prefix turns subjects into `{prefix}{pattern}`, and consumers then use exact `filter_subjects` entries instead of a single wildcard filter. See [Bring Your Own Infrastructure](/docs/guides/external-infrastructure#custom-names-and-subject-prefixes) for how prefixes interact with scheduling subjects.

:::tip The toNanos() helper
NATS JetStream uses nanoseconds for every time-based setting. `toNanos(value, unit)` converts a readable duration, taking `'ms'`, `'seconds'`, `'minutes'`, `'hours'` or `'days'`.
:::

### OrderedEventOverrides

Ordered events use a separate stream with Limits retention and deliver in strict sequence, at most once. The consumers are ephemeral and managed by the `@nats-io/jetstream` client, so this block is smaller than `StreamConsumerOverrides`.

| Field           | Type                       | Default                                              | What it does                                                                                                                                                                                             |
| --------------- | -------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream`        | `StreamConfigOverrides`    | production defaults                                  | Stream overrides such as `max_age` and `max_bytes`.                                                                                                                                                      |
| `consumer`      | `OrderedConsumerOverrides` | nats.js defaults                                     | Ordered-consumer options in raw nats.js spelling: `deliver_policy`, `opt_start_seq`, `opt_start_time`, `replay_policy`, `inactive_threshold`, `headers_only`. `filter_subjects` comes from the handlers. |
| `management`    | `ManagementMode`           | falls back to `provisioning.management`, then `Auto` | Ordered consumers are ephemeral, so only the stream has a mode.                                                                                                                                          |
| `subjectPrefix` | `string`                   | library convention                                   | Custom subject prefix for ordered-event subjects.                                                                                                                                                        |

```typescript
import { DeliverPolicy } from '@nats-io/jetstream';

ordered: {
  consumer: { deliver_policy: DeliverPolicy.New },   // only new messages
  stream: { max_age: toNanos(12, 'hours') },
}
```

See [Ordered Events](/docs/patterns/ordered-events) for detailed usage.

## connectionOptions

`connectionOptions` passes raw `ConnectionOptions` from `@nats-io/transport-node` to the NATS client, for TLS, authentication and reconnection.

:::warning Precedence
The top-level `name` and `servers` win over the same keys in `connectionOptions`. Do not set them there.
:::

### TLS

The `tls` block goes straight to `@nats-io/transport-node`, so every [`TlsOptions`](https://github.com/nats-io/nats.js/tree/main/transport-node) field works: file paths (`certFile`, `keyFile`, `caFile`) or inline PEM (`cert`, `key`, `ca`).

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://nats.prod.internal:4222'],
  connectionOptions: {
    tls: {
      // mTLS with client cert + private key, plus a self-signed CA
      certFile: '/certs/client.crt',
      keyFile: '/certs/client.key',
      caFile: '/certs/ca.crt',
    },
  },
})
```

For server-only TLS against a broker whose CA your system already trusts, `tls: {}` is enough: the client upgrades the connection without sending a client identity.

### Authentication

```typescript
// Token authentication
connectionOptions: {
  token: process.env.NATS_TOKEN,
}

// User/password authentication
connectionOptions: {
  user: process.env.NATS_USER,
  pass: process.env.NATS_PASS,
}
```

### Reconnection

```typescript
connectionOptions: {
  maxReconnectAttempts: -1,     // unlimited reconnection attempts
  reconnectTimeWait: 2_000,    // 2s between reconnection attempts
  reconnectJitter: 500,        // add up to 500ms random jitter
}
```

## Publisher-only mode

`publisherOnly: true` skips all consumer infrastructure, for API gateways and other services that only publish:

```typescript
JetstreamModule.forRoot({
  name: 'api-gateway',
  servers: ['nats://localhost:4222'],
  publisherOnly: true, // no streams, consumers, or message routing
})
```

The `JetstreamStrategy` provider then resolves to `null`: do not call `app.connectMicroservice()` or `app.get(JetstreamStrategy)` in `main.ts`.

## What's next?

- [**RPC Patterns**](/docs/patterns/rpc): how Core and JetStream mode differ on errors and timeouts
- [**Events & Broadcast**](/docs/patterns/events): workqueue events and fan-out delivery
- [**Scheduling (Delayed Jobs)**](/docs/guides/scheduling): one-shot delayed delivery
- [**Recurring Schedules**](/docs/guides/recurring-schedules): cron and interval handlers on the `schedule` stream
- [**Lifecycle Hooks**](/docs/guides/lifecycle-hooks): monitor connection state and transport events
- [**Default Configs**](/docs/reference/default-configs): full list of the stream and consumer defaults
