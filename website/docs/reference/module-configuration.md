---
sidebar_position: 1
sidebar_label: "Module Configuration"
title: "Module Configuration — NestJS JetStream Transport"
description: "Reference for forRoot(), forRootAsync(), and forFeature() registration methods, plus stream, consumer, RPC, and connection options."
schema:
  type: Article
  headline: "Module Configuration Reference"
  description: "Reference for forRoot(), forRootAsync(), and forFeature() registration methods with stream, consumer, and connection options."
  datePublished: "2026-03-21"
  dateModified: "2026-06-12"
---

import Since from '@site/src/components/Since';

# Module Configuration

Reference for the three registration methods exposed by `JetstreamModule`: `forRoot()` for global setup, `forRootAsync()` for async/dynamic configuration, and `forFeature()` for per-module client registration. Every option is listed below with its type and default. For a guided introduction see the [Quick Start](/docs/getting-started/quick-start).

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

:::info The `name` lives outside the factory
The `name` property is defined at the top level of `forRootAsync()`, not inside the factory return value. This is by design — the name is needed upfront for DI token generation before the factory runs.
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

The `NatsConfigService` must be a class-based provider that directly implements `Omit<JetstreamModuleOptions, 'name'>` — the instance itself is used as the options object (NestJS does not call a factory method on it).

### useClass

Similar to `useExisting`, but the class is instantiated by the module:

```typescript
JetstreamModule.forRootAsync({
  name: 'orders',
  useClass: NatsConfigService,
})
```

## forFeature()

`forFeature()` creates a lightweight `JetstreamClient` proxy for a target service. It reuses the shared NATS connection from `forRoot()` — no new connections are created.

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

The library exports a `getClientToken(name)` helper that returns the same string — it exists for code bases that prefer explicit symbolic tokens, but `@Inject('users')` is the canonical form and the one used throughout these docs.

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

Every field in `JetstreamModuleOptions` with its type, default, and guidance on when to change it.

### Required options

#### `name` &mdash; `string`

Service name. Used for stream, consumer, and subject naming. Must be unique per service in your system.

#### `servers` &mdash; `string[]`

NATS server URLs (e.g., `['nats://localhost:4222']`).

### Optional options

#### `codec` &mdash; `Codec`

Default: `JsonCodec`. Global message serializer/deserializer. Swap for MessagePack, Protobuf, or any custom binary format. See [Custom Codec](/docs/guides/custom-codec).

#### `rpc` &mdash; `RpcConfig`

Default: `{ mode: 'core' }`. RPC transport mode and configuration. See [RpcConfig](#rpcconfig) below.

#### `consumer` &mdash; `boolean`

Default: `true`. Enable consumer infrastructure. Set to `false` for publisher-only services (e.g., API gateways).

#### `events` &mdash; `StreamConsumerOverrides`

Default: production defaults (see [Default Configs](/docs/reference/default-configs#stream-defaults)). Overrides for workqueue event stream and consumer config. To enable [message scheduling](/docs/guides/scheduling), set `events.stream.allow_msg_schedules: true` (requires NATS >= 2.12). <Since version="2.8.0" />

#### `broadcast` &mdash; `StreamConsumerOverrides`

Default: production defaults. Overrides for broadcast event stream and consumer config.

#### `ordered` &mdash; `OrderedEventOverrides`

Default: production defaults. Configuration for ordered event consumers. See [OrderedEventOverrides](#orderedeventoverrides) below. <Since version="2.4.0" />

#### `hooks` &mdash; `Partial<TransportHooks>`

Default: none. Transport lifecycle hook handlers. Unset hooks are silently ignored. See [Lifecycle Hooks](/docs/guides/lifecycle-hooks).

#### `onDeadLetter` &mdash; `(info: DeadLetterInfo) => Promise<void>`

Default: none. Async callback for dead letter handling. Called and awaited when a message exhausts all delivery attempts. See [Dead Letter Queue](/docs/guides/dead-letter-queue). <Since version="2.2.0" />

#### `dlq` &mdash; `{ stream?: StreamConfigOverrides; management?: EntityManagement }`

Default: none. Built-in Dead Letter Queue stream. When set, exhausted messages are automatically republished to a dedicated DLQ stream with tracking headers. The optional `management` field controls whether the DLQ stream is auto-provisioned (`Auto`, default) or externally managed (`Manual`). See [Built-in DLQ stream](/docs/guides/dead-letter-queue#built-in-dlq-stream) and [External DLQ](/docs/guides/external-infrastructure#external-dlq). <Since version="2.9.0" />

#### `provisioning` &mdash; `ProvisioningOptions`

Default: `{ management: ManagementMode.Auto }`. Controls global provisioning behavior. <Since version="2.10.0" />

The most important field is `management`:

```typescript
import { ManagementMode } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  provisioning: {
    management: ManagementMode.Manual, // bind to all entities; never create or update
  },
})
```

| `management` value | Behavior |
|---|---|
| `ManagementMode.Auto` | Library creates and updates every entity. **Default.** |
| `ManagementMode.Manual` | Library binds to existing entities; fails at boot if any are absent. |

The global value can be overridden per entity via `events.management`, `broadcast.management`, etc. Resolution order: per-entity → global → `Auto`. See [Bring Your Own Infrastructure](/docs/guides/external-infrastructure) for a complete guide.

#### `metadata` &mdash; `MetadataRegistryOptions`

Default: auto-enabled if any handler has `meta`. Handler metadata registry — publishes `@EventPattern` / `@MessagePattern` handler metadata to a NATS KV bucket for cross-service discovery. No-op when `consumer: false`. See [Handler Metadata](/docs/patterns/handler-metadata). <Since version="2.9.0" />

#### `metrics` &mdash; `MetricsOption`

Default: none. Built-in Prometheus metrics. Pass `true` for defaults or a `MetricsConfig` object for full control (custom registry, prefix, labels, polling interval, histogram buckets). Requires the optional `prom-client` peer dependency when enabled. See [Prometheus Metrics](/docs/observability/metrics). <Since version="2.11.0" />

#### `allowDestructiveMigration` &mdash; `boolean`

Default: `false`. Allow automatic blue-green stream recreation for immutable property changes (e.g., `storage`). Without this flag, the transport logs a warning and keeps the existing stream config. See [Stream Migration](/docs/guides/stream-migration). <Since version="2.9.0" />

#### `shutdownTimeout` &mdash; `number`

Default: `10_000` (10 s). Graceful shutdown timeout in milliseconds. Handlers exceeding this are abandoned.

#### `connectionOptions` &mdash; `Partial<ConnectionOptions>`

Default: none. Raw NATS `ConnectionOptions` pass-through for TLS, auth, reconnection, etc. See [connectionOptions](#connectionoptions) below.

#### `otel` &mdash; `OtelOptions`

Default: enabled with sensible defaults. OpenTelemetry tracing configuration. See [Distributed Tracing](/docs/observability/tracing).

### RpcConfig

RPC configuration is a discriminated union on `mode`. Pick the mode based on whether commands must survive handler downtime:

**`mode: 'core'`** &mdash; default. NATS native request/reply, no persistence. Lowest latency. Default timeout `30_000` ms (30 s). Best for low-latency queries and lookups where in-flight requests can simply error on failure.

**`mode: 'jetstream'`** &mdash; commands persisted in a JetStream stream before delivery. Default timeout `180_000` ms (3 min). Best for commands that must survive a handler restart (payments, state changes).

:::note Timeout unit
The `timeout` field is specified in **milliseconds**, not seconds. Writing `timeout: 30` means 30 ms — almost certainly a bug. Use `timeout: 30_000` for 30 seconds.
:::

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

:::info Timeout applies to both sides
The `timeout` value controls both the **client-side wait** (how long the caller waits for a response) and the **server-side handler limit** (how long the handler is allowed to run before being terminated). Both sides use the value from their own `forRoot()` configuration.
:::

The `mode: 'jetstream'` variant also accepts `management` and `subjectPrefix` fields with the same semantics as `StreamConsumerOverrides`. <Since version="2.10.0" />

See [RPC Patterns](/docs/patterns/rpc) for a full comparison of the two modes.

### StreamConsumerOverrides

The `events` and `broadcast` fields accept stream and consumer configuration overrides:

```typescript
import { toNanos } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  events: {
    stream: {
      max_age: toNanos(3, 'days'), // 3 days instead of default 7
      max_bytes: 512 * 1024 * 1024,              // 512 MB instead of default 5 GB
    },
    consumer: {
      max_deliver: 5,          // retry 5 times instead of default 3
      ack_wait: toNanos(30, 'seconds'), // 30s ack timeout instead of default 10s
    },
  },
})
```

These overrides are merged with the [production defaults](/docs/reference/default-configs). You only need to specify the fields you want to change.

:::tip The toNanos() helper
NATS JetStream uses nanoseconds for all time-based configuration. The library exports a `toNanos(value, unit)` helper that converts human-readable durations to nanoseconds. Supported units: `'ms'`, `'seconds'`, `'minutes'`, `'hours'`, `'days'`.
:::

#### `stream.name` &mdash; `string`

Default: derived from `name` + kind convention (e.g., `orders__microservice_ev-stream`). Set an explicit stream name to bind to an externally provisioned stream with a custom name. <Since version="2.10.0" />

```typescript
events: {
  stream: { name: 'platform_orders_stream' },
}
```

#### `consumer.durable_name` &mdash; `string`

Default: derived from `name` + kind convention (e.g., `orders__microservice_ev-consumer`). Set an explicit durable name to bind to an externally provisioned consumer. <Since version="2.10.0" />

```typescript
events: {
  consumer: { durable_name: 'platform_orders_worker' },
}
```

#### `management` &mdash; `EntityManagement`

Default: falls back to `provisioning.management`, then `ManagementMode.Auto`. Per-kind provisioning control with separate overrides for the stream and consumer: <Since version="2.10.0" />

```typescript
import { ManagementMode } from '@horizon-republic/nestjs-jetstream';

events: {
  management: {
    stream:   ManagementMode.Manual, // bind to external stream
    consumer: ManagementMode.Auto,   // library manages the consumer
  },
}
```

#### `subjectPrefix` &mdash; `string`

Default: library convention (e.g., `orders__microservice.ev.`). Override the subject prefix for all subjects in this kind. The trailing dot is normalized automatically. When a custom prefix is set, subjects become `{prefix}{pattern}` and consumers use exact `filter_subjects` entries instead of a single wildcard filter. <Since version="2.10.0" />

```typescript
events: {
  subjectPrefix: 'company.orders.', // publishes to company.orders.{pattern}
}
```

See [Bring Your Own Infrastructure](/docs/guides/external-infrastructure#custom-names-and-subject-prefixes) for how custom prefixes interact with scheduling subjects.

### OrderedEventOverrides

<Since version="2.4.0" />

Ordered events use a separate stream with Limits retention and deliver messages in strict sequential order. The configuration is simpler than workqueue/broadcast because ordered consumers are ephemeral and auto-managed by the `@nats-io/jetstream` client.

```typescript
import { DeliverPolicy } from '@nats-io/jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  ordered: {
    deliverPolicy: DeliverPolicy.New,   // only new messages (default: All)
    stream: {
      max_age: toNanos(12, 'hours'), // 12 hours
    },
  },
})
```

#### `stream` &mdash; `Partial<StreamConfig>`

Default: production defaults. Stream overrides (e.g., `max_age`, `max_bytes`).

#### `deliverPolicy` &mdash; `DeliverPolicy`

Default: `DeliverPolicy.All`. Where to start reading when the consumer is created.

#### `optStartSeq` &mdash; `number`

Default: none. Start sequence number. Only used with `DeliverPolicy.StartSequence`.

#### `optStartTime` &mdash; `string`

Default: none. Start time as an ISO string. Only used with `DeliverPolicy.StartTime`.

#### `replayPolicy` &mdash; `ReplayPolicy`

Default: `ReplayPolicy.Instant`. Replay policy for historical messages.

#### `management` &mdash; `EntityManagement`

Default: falls back to `provisioning.management`, then `ManagementMode.Auto`. Per-kind provisioning control for the ordered stream. Same semantics as `StreamConsumerOverrides.management`. <Since version="2.10.0" />

#### `subjectPrefix` &mdash; `string`

Default: library convention. Custom subject prefix for ordered-event subjects. Same semantics as `StreamConsumerOverrides.subjectPrefix`. <Since version="2.10.0" />

See [Ordered Events](/docs/patterns/ordered-events) for detailed usage.

## connectionOptions

The `connectionOptions` field passes raw NATS `ConnectionOptions` (from `@nats-io/transport-node`) directly to the NATS client. Use it for TLS, authentication, and reconnection configuration.

:::warning Precedence
The `name` and `servers` fields from the top-level options take precedence over anything set in `connectionOptions`. Don't duplicate them.
:::

### TLS

The `tls` block is passed straight through to `@nats-io/transport-node`, so any field supported by its [`TlsOptions`](https://github.com/nats-io/nats.js/tree/main/transport-node) works here — paths (`certFile`, `keyFile`, `caFile`), inline PEM (`cert`, `key`, `ca`), or an empty `tls: {}` for server-only TLS against a broker whose CA your system already trusts.

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

For server-only TLS (no client certificate) against a publicly-trusted broker, `tls: {}` is enough — it tells the client to upgrade the connection without sending a client identity.

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

In publisher-only mode, the `JetstreamStrategy` provider resolves to `null`. Do **not** call `app.connectMicroservice()` or `app.get(JetstreamStrategy)`.

```typescript title="src/main.ts"
const bootstrap = async () => {
  const app = await NestFactory.create(AppModule);

  // No microservice connection needed in publisher-only mode
  await app.listen(3000);
};

void bootstrap();
```

## What's next?

- [**RPC Patterns**](/docs/patterns/rpc) — Core vs JetStream mode, error handling, and timeouts
- [**Events & Broadcast**](/docs/patterns/events) — workqueue events and fan-out delivery
- [**Scheduling (Delayed Jobs)**](/docs/guides/scheduling) — one-shot delayed delivery via NATS 2.12
- [**Lifecycle Hooks**](/docs/guides/lifecycle-hooks) — monitor connection state and transport events
- [**Default Configs**](/docs/reference/default-configs) — full list of production-ready stream and consumer defaults
