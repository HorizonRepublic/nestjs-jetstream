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
  dateModified: "2026-08-03"
---

# Module Configuration

> **Use when:** you are looking up a specific option or its default.
> **You get:** every key `forRoot()`, `forRootAsync()` and `forFeature()` accept, with type and default.

Reference for the three registration methods exposed by `JetstreamModule`: `forRoot()` for global setup, `forRootAsync()` for async/runtime configuration, and `forFeature()` for per-module client registration. Every option is listed below with its type and default. For a guided introduction see the [Quick Start](/docs/getting-started/quick-start).

## forRoot()

`forRoot()` registers the transport globally. Call it **once** in your root `AppModule`. It creates the shared NATS connection, codec, event bus, and (optionally) the full consumer infrastructure.

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

The `name` field drives all NATS resource naming. Given `name: 'user-events'`:

- **Event stream:** `user-events__microservice_ev-stream`
- **Event subjects:** `user-events__microservice.ev.{pattern}` (e.g., `user-events__microservice.ev.user.created`)
- **Consumer:** `user-events__microservice_ev-consumer`

The `__microservice` suffix provides namespace isolation from other NATS clients on the same cluster. See [Naming Conventions](/docs/reference/naming-conventions) for the full naming table and helper functions.

## forRootAsync()

For real-world applications, you'll typically load configuration from environment variables or a config service. `forRootAsync()` supports three patterns.

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
The `name` property is defined at the top level of `forRootAsync()`, not inside the factory return value. This is by design: the name is needed upfront for DI token generation before the factory runs.
:::

### useExisting

Point to an already-registered provider that implements the options interface:

```typescript
JetstreamModule.forRootAsync({
  name: 'orders',
  imports: [NatsConfigModule],
  useExisting: NatsConfigService,
})
```

The `NatsConfigService` must be a class-based provider that directly implements `Omit<JetstreamModuleOptions, 'name'>`: the instance itself is used as the options object (NestJS does not call a factory method on it).

### useClass

Like `useExisting`, but the class is instantiated by the module:

```typescript
JetstreamModule.forRootAsync({
  name: 'orders',
  useClass: NatsConfigService,
})
```

## forFeature()

`forFeature()` creates a lightweight `JetstreamClient` proxy for a target service. It reuses the shared NATS connection from `forRoot()`: no new connections are created.

Import it in each feature module that needs to communicate with a specific service:

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

Inject the client using `@Inject()` with the service name as the token:

```typescript title="src/orders/orders.service.ts"
import { Injectable, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, lastValueFrom } from 'rxjs';

@Injectable()
export class OrdersService {
  constructor(
    @Inject('users') private readonly usersClient: ClientProxy,
    @Inject('payments') private readonly paymentsClient: ClientProxy,
  ) {}

  async createOrder(userId: number) {
    // RPC call to the users service
    const user = await firstValueFrom(
      this.usersClient.send('user.get', { id: userId }),
    );

    // Fire-and-forget event to the payments service
    await lastValueFrom(
      this.paymentsClient.emit('payment.initiate', {
        userId,
        amount: 99.99,
      }),
    );
  }
}
```

### Injection token

The injection token is the service name string you passed to `forFeature({ name })`. Use the standard NestJS pattern:

```typescript
@Inject('users')
private readonly usersClient: ClientProxy;
```

The library exports a `getClientToken(name)` helper that returns the same string; it exists for code bases that prefer explicit symbolic tokens, but `@Inject('users')` is the canonical form and the one used throughout these docs.

### Per-client codec override

Each `forFeature()` client can use a different codec, falling back to the global codec from `forRoot()` when omitted:

```typescript
import { MsgPackCodec } from './codecs/msgpack.codec';

JetstreamModule.forFeature({
  name: 'legacy-service',
  codec: new MsgPackCodec(),
})
```

See [Custom Codec](/docs/guides/custom-codec) for how to implement the `Codec` interface.

## Full options reference

Every field in `JetstreamModuleOptions`. The blocks that need more than a line have a section of their own below.

### Root options

| Option                      | Type                                         | Default                | What it does                                                                                          |
| --------------------------- | -------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `name`                      | `string`                                     | required               | Drives stream, consumer and subject naming. Unique per service.                                       |
| `servers`                   | `string[]`                                   | required               | NATS server URLs. Required unless you use `connections`, and supplying both fails at startup.         |
| `connections`               | `Record<string, JetstreamConnectionOptions>` | none                   | One entry per NATS cluster, mutually exclusive with `servers`. See [connections](#connections).       |
| `defaultConnection`         | `string`                                     | none                   | Which connection unqualified handlers and clients bind to.                                            |
| `codec`                     | `Codec`                                      | `JsonCodec`            | Message serializer. See [Custom Codec](/docs/guides/custom-codec).                                    |
| `consumer`                  | `boolean`                                    | `true`                 | Consumer infrastructure. `false` gives a [publisher-only](#publisher-only-mode) service.              |
| `rpc`                       | `RpcConfig`                                  | `{ mode: 'core' }`     | RPC transport mode. See [RpcConfig](#rpcconfig).                                                      |
| `events`                    | `StreamConsumerOverrides`                    | production defaults    | Workqueue event stream and consumer. See [StreamConsumerOverrides](#streamconsumeroverrides).         |
| `broadcast`                 | `StreamConsumerOverrides`                    | production defaults    | Broadcast event stream and consumer, same shape as `events`.                                          |
| `ordered`                   | `OrderedEventOverrides`                      | production defaults    | Ordered event consumers. See [OrderedEventOverrides](#orderedeventoverrides).                         |
| `dlq`                       | `DlqOptions \| false`                        | enabled                | Republishes exhausted messages to a dedicated stream. See [dlq](#dlq).                                |
| `onDeadLetter`              | `(info: DeadLetterInfo) => Promise<void>`    | none                   | Awaited when a message exhausts every delivery attempt.                                               |
| `hooks`                     | `Partial<TransportHooks>`                    | none                   | Lifecycle hook handlers. Unset hooks are ignored in silence.                                          |
| `metrics`                   | `MetricsOption`                              | none                   | Prometheus metrics. `true` for defaults, or a `MetricsConfig`. Needs the optional `prom-client` peer. |
| `otel`                      | `OtelOptions \| boolean`                     | enabled                | Tracing. `false` turns it off entirely.                                                               |
| `metadata`                  | `MetadataRegistryOptions`                    | auto                   | Handler metadata in NATS KV, on when any handler has `meta`. No-op when `consumer: false`.            |
| `provisioning`              | `ProvisioningOptions`                        | `{ management: Auto }` | Who owns streams and consumers. See [provisioning](#provisioning).                                    |
| `allowDestructiveMigration` | `boolean`                                    | `false`                | Permits blue-green recreation when an immutable property changes.                                     |
| `shutdownTimeout`           | `number`                                     | `10_000`               | Drain budget in milliseconds.                                                                         |
| `connectionOptions`         | `Partial<ConnectionOptions>`                 | none                   | Raw NATS options for TLS, auth and reconnection. See [connectionOptions](#connectionoptions).         |

`name`, `hooks`, `metrics`, `otel` and `onDeadLetter` stay at the root even when you use `connections`: they describe or observe the service as a whole.

### connections

Each entry inherits every root field it does not name, and may override `critical`, `consumer`, `codec`, `connectionOptions`, `events`, `broadcast`, `ordered`, `rpc`, `dlq`, `metadata`, `provisioning`, `allowDestructiveMigration` and `shutdownTimeout`.

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

Exhausted messages are republished to a dedicated DLQ stream with tracking headers. Pass `false` to turn it off and leave them where they land. `management` controls whether the stream is provisioned (`Auto`, the default) or bound to an existing one (`Manual`).

See [Built-in DLQ stream](/docs/guides/dead-letter-queue#built-in-dlq-stream) and [External DLQ](/docs/guides/external-infrastructure#external-dlq).

:::note Bind-only deployments
Under `provisioning: { management: Manual }` the implicit default stands down, since a service that provisions nothing should not fail boot over a stream nobody asked for. Set `dlq` explicitly to bind to an externally provisioned one.
:::

### events.retry and broadcast.retry

`readonly number[] | false`, default `[2000, 10000]`. Delay in milliseconds before each redelivery after a handler throws or calls `ctx.retry()`. Index 0 is the first retry, and the last entry repeats once the curve runs out. `false` naks immediately, which burns every attempt as fast as the handler can fail.

The delays are applied client-side when the message is naked, not through the consumer's `backoff`, so `ack_wait` keeps its configured value.

```typescript
events: {
  consumer: { max_deliver: 5 },
  retry: [1_000, 5_000, 30_000, 60_000],
}
```

### provisioning

| Field                   | Type             | Default               | What it does                                                                                                               |
| ----------------------- | ---------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `management`            | `ManagementMode` | `ManagementMode.Auto` | `Auto` creates and updates every entity. `Manual` binds to existing ones and fails at boot if any are absent.              |
| `preflightStorageCheck` | `boolean`        | `false`               | Calls `getAccountInfo()` before provisioning and warns if the streams would not fit the account budget. Never blocks boot. |

Override `management` per entity through `events.management`, `broadcast.management` and so on. Resolution order is per-entity, then global, then `Auto`. See [Bring Your Own Infrastructure](/docs/guides/external-infrastructure).

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

The `'jetstream'` variant also accepts `management` and `subjectPrefix`, with the same meaning as in `StreamConsumerOverrides`.

:::note Timeout is milliseconds, and applies to both sides
Writing `timeout: 30` means 30 ms, which is a bug in almost every case. Use `timeout: 30_000` for 30 seconds. The value bounds both the caller's wait and the handler's run, each side reading it from its own `forRoot()`.
:::

See [RPC Patterns](/docs/patterns/rpc) for a full comparison of the two modes.

### StreamConsumerOverrides

Accepted by `events` and `broadcast`. Overrides merge with the [production defaults](/docs/reference/default-configs), so name only what you want to change.

| Field                   | Type                         | Default                                              | What it does                                                           |
| ----------------------- | ---------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `stream`                | `Partial<StreamConfig>`      | production defaults                                  | Stream overrides such as `max_age` and `max_bytes`.                    |
| `consumer`              | `Partial<ConsumerConfig>`    | production defaults                                  | Consumer overrides such as `max_deliver` and `ack_wait`.               |
| `consume`               | `ConsumeOptions`             | production defaults                                  | Fetch-loop options such as `idle_heartbeat`.                           |
| `concurrency`           | `number`                     | production default                                   | How many messages this kind processes at once.                         |
| `ackExtension`          | `boolean`                    | `false`                                              | Keeps extending the ack deadline while a slow handler runs.            |
| `retry`                 | `readonly number[] \| false` | `[2000, 10000]`                                      | Redelivery curve. See [events.retry](#eventsretry-and-broadcastretry). |
| `stream.name`           | `string`                     | `{service}__microservice_ev-stream` and friends      | Bind to an externally provisioned stream with a custom name.           |
| `consumer.durable_name` | `string`                     | `{service}__microservice_ev-consumer` and friends    | Bind to an externally provisioned consumer.                            |
| `management`            | `EntityManagement`           | falls back to `provisioning.management`, then `Auto` | Per-kind control, with separate `stream` and `consumer` entries.       |
| `subjectPrefix`         | `string`                     | `{service}__microservice.ev.` and friends            | Custom subject prefix. The trailing dot is normalized.                 |

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

Ordered events use a separate stream with Limits retention and deliver in strict sequence. The consumers are ephemeral and managed by the `@nats-io/jetstream` client, so this block is smaller than the two above.

| Field           | Type                    | Default                                              | What it does                                                           |
| --------------- | ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `stream`        | `Partial<StreamConfig>` | production defaults                                  | Stream overrides such as `max_age` and `max_bytes`.                    |
| `deliverPolicy` | `DeliverPolicy`         | `DeliverPolicy.All`                                  | Where to start reading when the consumer is created.                   |
| `optStartSeq`   | `number`                | none                                                 | Start sequence, used only with `DeliverPolicy.StartSequence`.          |
| `optStartTime`  | `string`                | none                                                 | Start time as an ISO string, used only with `DeliverPolicy.StartTime`. |
| `replayPolicy`  | `ReplayPolicy`          | `ReplayPolicy.Instant`                               | Replay policy for historical messages.                                 |
| `management`    | `EntityManagement`      | falls back to `provisioning.management`, then `Auto` | Per-kind provisioning control for the ordered stream.                  |
| `subjectPrefix` | `string`                | library convention                                   | Custom subject prefix for ordered-event subjects.                      |

```typescript
import { DeliverPolicy } from '@nats-io/jetstream';

ordered: {
  deliverPolicy: DeliverPolicy.New,        // only new messages
  stream: { max_age: toNanos(12, 'hours') },
}
```

See [Ordered Events](/docs/patterns/ordered-events) for detailed usage.

## connectionOptions

The `connectionOptions` field passes raw NATS `ConnectionOptions` (from `@nats-io/transport-node`) directly to the NATS client. Use it for TLS, authentication, and reconnection configuration.

:::warning Precedence
The `name` and `servers` fields from the top-level options take precedence over anything set in `connectionOptions`. Don't duplicate them.
:::

### TLS

The `tls` block is passed straight through to `@nats-io/transport-node`, so any field supported by its [`TlsOptions`](https://github.com/nats-io/nats.js/tree/main/transport-node) works here; paths (`certFile`, `keyFile`, `caFile`), inline PEM (`cert`, `key`, `ca`), or an empty `tls: {}` for server-only TLS against a broker whose CA your system already trusts.

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

For server-only TLS (no client certificate) against a publicly-trusted broker, `tls: {}` is enough: it tells the client to upgrade the connection without sending a client identity.

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

Set `consumer: false` to skip all consumer infrastructure. This is useful for API gateways or services that only publish messages and never handle them:

```typescript
JetstreamModule.forRoot({
  name: 'api-gateway',
  servers: ['nats://localhost:4222'],
  consumer: false, // no streams, consumers, or message routing
})
```

In publisher-only mode, the `JetstreamStrategy` provider resolves to `null`. Do not call `app.connectMicroservice()` or `app.get(JetstreamStrategy)`.

```typescript title="src/main.ts"
const bootstrap = async () => {
  const app = await NestFactory.create(AppModule);

  // No microservice connection needed in publisher-only mode
  await app.listen(3000);
};

void bootstrap();
```

## What's next?

- [**RPC Patterns**](/docs/patterns/rpc): how Core and JetStream mode differ on errors and timeouts
- [**Events & Broadcast**](/docs/patterns/events): workqueue events and fan-out delivery
- [**Scheduling (Delayed Jobs)**](/docs/guides/scheduling): one-shot delayed delivery via NATS 2.12
- [**Lifecycle Hooks**](/docs/guides/lifecycle-hooks): monitor connection state and transport events
- [**Default Configs**](/docs/reference/default-configs): full list of the stream and consumer defaults
