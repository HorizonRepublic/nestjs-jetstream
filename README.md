# @horizon-republic/nestjs-jetstream

A production-grade NestJS transport for NATS JetStream with built-in support for **Events**, **Broadcast**, **Ordered Events**, and **RPC** messaging patterns.

[![npm version](https://img.shields.io/npm/v/@horizon-republic/nestjs-jetstream.svg)](https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream)
[![codecov](https://codecov.io/github/HorizonRepublic/nestjs-jetstream/graph/badge.svg?token=40IPSWFMT4)](https://codecov.io/github/HorizonRepublic/nestjs-jetstream)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Socket Badge](https://badge.socket.dev/npm/package/@horizon-republic/nestjs-jetstream)](https://socket.dev/npm/package/@horizon-republic/nestjs-jetstream)

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Module Configuration](#module-configuration)
  - [forRoot / forRootAsync](#forroot--forrootasync)
  - [forFeature](#forfeature)
  - [Full Options Reference](#full-options-reference)
- [Messaging Patterns](#messaging-patterns)
  - [RPC (Request/Reply)](#rpc-requestreply)
  - [Events](#events)
  - [Ordered Events](#ordered-events)
  - [JetstreamRecord Builder](#jetstreamrecord-builder)
- [Handler Context & Serialization](#handler-context--serialization)
  - [RpcContext](#rpccontext)
  - [Custom Codec](#custom-codec)
- [Operations](#operations)
  - [Lifecycle Hooks](#lifecycle-hooks)
  - [Health Checks](#health-checks)
  - [Graceful Shutdown](#graceful-shutdown)
- [Reference](#reference)
  - [Edge Cases & Important Notes](#edge-cases--important-notes)
  - [NATS Naming Conventions](#nats-naming-conventions)
  - [Default Stream & Consumer Configs](#default-stream--consumer-configs)
  - [API Reference](#api-reference)
- [Development](#development)
  - [Testing](#testing)
  - [Contributing](#contributing)
- [License](#license)
- [Links](#links)

## Features

- **Two RPC modes** — NATS Core request/reply (lowest latency) or JetStream-persisted commands
- **At-least-once event delivery** — messages acked after handler success, redelivered on failure
- **Ordered events** — strict sequential delivery with automatic failover, separate Limits-retention stream
- **Broadcast events** — fan-out to all subscribing services with per-service durable consumers
- **Pluggable codec** — JSON by default, swap in MessagePack, Protobuf, or any custom format
- **Progressive configuration** — two lines to start, full NATS overrides for power users
- **Lifecycle hooks** — observable events for connect, disconnect, errors, timeouts, shutdown
- **Graceful shutdown** — drain in-flight messages before closing the connection
- **Publisher-only mode** — set `consumer: false` for API gateways that only send messages
- **Per-feature codec override** — different serialization per target service

## Installation

```bash
npm install @horizon-republic/nestjs-jetstream
# or
pnpm add @horizon-republic/nestjs-jetstream
# or
yarn add @horizon-republic/nestjs-jetstream
```

**Peer dependencies:**

```
@nestjs/common        ^10.2.0 || ^11.0.0
@nestjs/core          ^10.2.0 || ^11.0.0
@nestjs/microservices ^10.2.0 || ^11.0.0
nats                  ^2.0.0
reflect-metadata      ^0.2.0
rxjs                  ^7.8.0
```

## Quick Start

### 1. Register the module

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';

@Module({
  imports: [
    // Global setup — once per application
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['nats://localhost:4222'],
    }),

    // Client for sending messages to the "orders" service
    JetstreamModule.forFeature({ name: 'orders' }),
  ],
})
export class AppModule {}
```

### 2. Connect the transport

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { JetstreamStrategy } from '@horizon-republic/nestjs-jetstream';
import { AppModule } from './app.module';

const bootstrap = async () => {
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice(
    { strategy: app.get(JetstreamStrategy) },
    { inheritAppConfig: true },
  );

  await app.startAllMicroservices();
  await app.listen(3000);
};

void bootstrap();
```

### 3. Define handlers

```typescript
import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

@Controller()
export class OrdersController {
  @EventPattern('order.created')
  handleOrderCreated(@Payload() data: { orderId: number }) {
    console.log('Order created:', data.orderId);
  }

  @MessagePattern('order.get')
  getOrder(@Payload() data: { id: number }) {
    return { id: data.id, status: 'shipped' };
  }
}
```

### 4. Send messages

```typescript
import { Controller, Get, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

@Controller()
export class AppController {
  constructor(@Inject('orders') private client: ClientProxy) {}

  @Get('create')
  createOrder() {
    return this.client.emit('order.created', { orderId: 42 });
  }

  @Get('get')
  getOrder() {
    return this.client.send('order.get', { id: 42 });
  }
}
```

## Module Configuration

### forRoot / forRootAsync

`forRoot()` registers the transport globally. Call it once in your root `AppModule`.

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  rpc: { mode: 'core', timeout: 10_000 },
  shutdownTimeout: 15_000,
  hooks: {
    [TransportEvent.Error]: (err, ctx) => sentry.captureException(err),
  },
})
```

For async configuration (e.g., loading from `ConfigService`):

```typescript
JetstreamModule.forRootAsync({
  name: 'orders',
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    servers: [config.get('NATS_URL')],
    rpc: { mode: config.get('RPC_MODE') as 'core' | 'jetstream' },
  }),
})
```

Also supports `useExisting` and `useClass` patterns.

### forFeature

`forFeature()` creates a lightweight client for a target service. Import in each feature module.

```typescript
// The client reuses the NATS connection from forRoot().
// No separate connection is created.
JetstreamModule.forFeature({ name: 'users' })
JetstreamModule.forFeature({ name: 'payments' })

// Optionally override the codec for a specific client
JetstreamModule.forFeature({ name: 'legacy-service', codec: new MsgPackCodec() })
```

Inject clients by the service name:

```typescript
constructor(
  @Inject('users') private usersClient: ClientProxy,
  @Inject('payments') private paymentsClient: ClientProxy,
) {}
```

### Full Options Reference

```typescript
interface JetstreamModuleOptions {
  /** Service name. Used for stream/consumer/subject naming. */
  name: string;

  /** NATS server URLs. */
  servers: string[];

  /**
   * Global message codec.
   * @default JsonCodec
   */
  codec?: Codec;

  /**
   * RPC transport mode.
   * @default { mode: 'core' }
   */
  rpc?: RpcConfig;

  /**
   * Enable consumer infrastructure (streams, consumers, message routing).
   * Set to false for publisher-only services (e.g., API gateways).
   * @default true
   */
  consumer?: boolean;

  /** Workqueue event stream/consumer overrides. */
  events?: { stream?: Partial<StreamConfig>; consumer?: Partial<ConsumerConfig> };

  /** Broadcast event stream/consumer overrides. */
  broadcast?: { stream?: Partial<StreamConfig>; consumer?: Partial<ConsumerConfig> };

  /** Ordered event consumer configuration. */
  ordered?: {
    deliverPolicy?: DeliverPolicy;   // default: All (read from beginning)
    optStartSeq?: number;            // for StartSequence policy
    optStartTime?: string;           // for StartTime policy (ISO string)
    replayPolicy?: ReplayPolicy;     // default: Instant
    stream?: Partial<StreamConfig>;  // stream overrides (e.g., max_age)
  };

  /** Transport lifecycle hook handlers. Unset hooks are silently ignored. */
  hooks?: Partial<TransportHooks>;

  /** Async callback for dead letter handling. See Dead Letter Queue section below. */
  onDeadLetter?: (info: DeadLetterInfo) => Promise<void>;

  /**
   * Graceful shutdown timeout in ms.
   * @default 10_000
   */
  shutdownTimeout?: number;

  /** Raw NATS ConnectionOptions pass-through (tls, auth, reconnect, etc.). */
  connectionOptions?: Partial<ConnectionOptions>;
}
```

#### Connection Options

Pass raw NATS `ConnectionOptions` for TLS, authentication, and reconnection:

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://nats.prod.internal:4222'],
  connectionOptions: {
    // TLS
    tls: {
      certFile: '/certs/client.crt',
      keyFile: '/certs/client.key',
      caFile: '/certs/ca.crt',
    },
    // Token auth
    token: process.env.NATS_TOKEN,
    // Or user/pass
    user: process.env.NATS_USER,
    pass: process.env.NATS_PASS,
    // Reconnection
    maxReconnectAttempts: -1, // unlimited
    reconnectTimeWait: 2000, // 2s between attempts
  },
})
```

#### RpcConfig

Discriminated union on `mode`:

| Mode          | Timeout Default | Persistence      | Use Case                               |
|---------------|-----------------|------------------|----------------------------------------|
| `'core'`      | 30s             | None             | Low-latency, simple RPC                |
| `'jetstream'` | 3 min           | JetStream stream | Commands must survive handler downtime |

> **Note:** `timeout` controls both the **client-side wait** (how long the caller waits for a response) and the **server-side handler limit** (how long the handler is allowed to run before being terminated). Both sides use the same value from their own `forRoot()` config.

```typescript
// Core mode (default)
rpc: { mode: 'core', timeout: 10_000 }

// JetStream mode with custom stream/consumer config
rpc: {
  mode: 'jetstream',
  timeout: 60_000,
  stream: { max_age: nanos(60_000) },
  consumer: { max_deliver: 3 },
}
```

## Messaging Patterns

### RPC (Request/Reply)

#### Core Mode (Default)

Uses NATS native `request/reply` for the lowest possible latency.

```typescript
// Configuration
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  // rpc: { mode: 'core' }  ← default, can be omitted
})
```

**How it works:**

1. Client calls `nc.request()` with a timeout
2. Server receives on a queue-group subscription (load-balanced across instances)
3. Handler executes and responds via `msg.respond()`
4. Client receives the response

**Error behavior:**

| Scenario              | Result                            |
|-----------------------|-----------------------------------|
| Handler success       | Response returned to caller       |
| Handler throws        | Error response returned to caller |
| No handler registered | Error response returned to caller |
| Server not running    | Client times out                  |
| Decode error          | Error response returned to caller |

#### JetStream Mode

Commands are persisted in a JetStream stream. Responses flow back via NATS Core inbox.

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  rpc: { mode: 'jetstream', timeout: 120_000 },
})
```

**How it works:**

1. Client publishes command to JetStream with `replyTo` and `correlationId` headers
2. Server pulls from consumer, executes handler
3. Server publishes response to the client's inbox via Core NATS
4. Server acks/terms the JetStream message

**Error behavior:**

| Scenario        | JetStream Action       | Client Result     |
|-----------------|------------------------|-------------------|
| Handler success | `ack`                  | Response returned |
| Handler throws  | `term` (no redelivery) | Error response    |
| Handler timeout | `term`                 | Client times out  |
| Decode error    | `term`                 | No response       |
| No handler      | `term`                 | No response       |

> **Why `term` instead of `nak` for RPC errors?** Redelivering a failed command could cause duplicate side effects. The caller is responsible for retrying.

### Events

#### Workqueue Events

Each event is delivered to **one** handler instance (load-balanced). Messages are acked **after** the handler completes successfully.

```typescript
// Sending
this.client.emit('order.created', { orderId: 42 });

// Handling
@EventPattern('order.created')
handleOrderCreated(@Payload() data: OrderCreatedDto) {
  // If this throws, the message is nak'd and redelivered (up to max_deliver times)
  await this.ordersService.process(data);
}
```

**Delivery semantics (at-least-once):**

| Scenario         | Action | Redelivery?                           |
|------------------|--------|---------------------------------------|
| Handler success  | `ack`  | No                                    |
| Handler throws   | `nak`  | Yes, up to `max_deliver` (default: 3) |
| Decode error     | `term` | No (malformed payload)                |
| No handler found | `term` | No (configuration error)              |

> Handlers **must be idempotent** — NATS may redeliver on failure or timeout.

**Custom stream/consumer configuration:**

```typescript
import { nanos } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  events: {
    stream: {
      max_age: nanos(3 * 24 * 60 * 60 * 1000), // 3 days instead of default 7
      max_bytes: 1024 * 1024 * 512,              // 512 MB instead of default 5 GB
    },
    consumer: {
      max_deliver: 5,          // retry up to 5 times instead of default 3
      ack_wait: nanos(30_000), // 30s ack timeout instead of default 10s
    },
  },
})
```

#### Broadcast Events

Broadcast events are delivered to **all** subscribing services. Each service gets its own durable consumer on a shared `broadcast-stream`.

```typescript
// Sending — use the 'broadcast:' prefix
this.client.emit('broadcast:config.updated', { key: 'theme', value: 'dark' });

// Handling — use { broadcast: true } in extras
@EventPattern('config.updated', { broadcast: true })
handleConfigUpdated(@Payload() data: ConfigDto) {
  this.configCache.invalidate(data.key);
}
```

Every service with this handler receives the message independently.

**Delivery guarantees:** Each service has its own durable consumer on the broadcast stream. Delivery tracking is fully isolated — if service A fails to process a message, only service A retries it (`nak`). Services B, C, D are not affected. This means broadcast provides **at-least-once delivery per consumer**, not at-most-once.

**Custom broadcast configuration:**

```typescript
import { nanos } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  broadcast: {
    stream: {
      max_age: nanos(7 * 24 * 60 * 60 * 1000), // keep messages for 7 days
    },
    consumer: {
      max_deliver: 5,
    },
  },
})
```

> **Note:** The broadcast stream is shared across all services — stream-level settings (e.g., `max_age`, `max_bytes`) affect everyone. Consumer-level settings are per-service.

### Ordered Events

Ordered events guarantee **strict sequential delivery** — messages are delivered in exactly the order they were published. This is useful for event sourcing, audit logs, and any scenario where processing order matters.

#### How it works

- Uses a **separate stream** with Limits retention (messages persist based on `max_age`, not on ack)
- **Ephemeral consumer per instance** — each running instance creates its own ordered consumer. All instances receive all messages independently (no load balancing)
- **No ack/nak/DLQ** — nats.js auto-acknowledges ordered consumer messages. Handler errors are logged but don't affect delivery (at-most-once semantics)
- **Self-healing** — if the consumer disconnects, nats.js automatically recreates it at the correct position

```typescript
// Sending — use the 'ordered:' prefix
this.client.emit('ordered:order.status', { orderId: 42, status: 'shipped' });

// Handling — use { ordered: true } in extras
@EventPattern('order.status', { ordered: true })
handleOrderStatus(@Payload() data: OrderStatusDto) {
  // Messages arrive in strict publish order
  await this.projectionService.apply(data);
}
```

#### Delivery semantics (at-most-once, strictly ordered)

| Scenario         | Action            | Redelivery? |
|------------------|-------------------|-------------|
| Handler success  | Auto-ack          | No          |
| Handler throws   | Logged, continues | No          |
| Decode error     | Logged, skipped   | No          |
| No handler found | Logged, skipped   | No          |

> **Important:** Ordered consumers provide **ordering guarantees** at the cost of **at-most-once delivery**. If your handler fails, the message is not retried — the consumer moves to the next message. If you need both ordering and guaranteed delivery, consider using an external offset tracking mechanism or a different messaging pattern (e.g., SQS FIFO).

#### Deliver policy

Control where the ordered consumer starts reading when it is (re)created:

| Policy           | Behavior                                      | Config                                                                                      |
|------------------|-----------------------------------------------|---------------------------------------------------------------------------------------------|
| `All` (default)  | Read from the beginning of the stream         | `ordered: {}` or omit                                                                       |
| `New`            | Only messages published after consumer starts | `ordered: { deliverPolicy: DeliverPolicy.New }`                                             |
| `Last`           | Start from the last message in the stream     | `ordered: { deliverPolicy: DeliverPolicy.Last }`                                            |
| `LastPerSubject` | Last message per subject                      | `ordered: { deliverPolicy: DeliverPolicy.LastPerSubject }`                                  |
| `StartSequence`  | From a specific sequence number               | `ordered: { deliverPolicy: DeliverPolicy.StartSequence, optStartSeq: 100 }`                 |
| `StartTime`      | From a specific timestamp                     | `ordered: { deliverPolicy: DeliverPolicy.StartTime, optStartTime: '2026-01-01T00:00:00Z' }` |

```typescript
import { DeliverPolicy, nanos } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'projections',
  servers: ['nats://localhost:4222'],
  ordered: {
    deliverPolicy: DeliverPolicy.New,
    stream: {
      max_age: nanos(7 * 24 * 60 * 60 * 1000), // keep 7 days of history
    },
  },
})
```

#### Use cases by deliver policy

| Policy           | Use case                                                                                                                                                                    | Example                                                            |
|------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| `All`            | **CQRS read model rebuild.** Each instance replays all events from the stream to build a local projection (cache, search index, materialized view). Full replay on restart. | Rebuilding an Elasticsearch index from order events                |
| `New`            | **Real-time dashboard.** Instance starts and only processes new events — history is irrelevant.                                                                             | Live order feed in admin panel, real-time metrics                  |
| `Last`           | **Current state initialization.** Instance receives the last known message (e.g., latest config or status) and then listens for updates.                                    | Initializing a config cache from the most recent config event      |
| `LastPerSubject` | **State snapshot across keys.** Stream has per-key subjects (`order.status.123`, `order.status.456`) — on startup, get the latest state of each key.                        | Populating an in-memory order status map on boot                   |
| `StartSequence`  | **Manual offset tracking.** Store the last processed sequence in a database, restart from that point. Enables exactly-once processing with external state.                  | Resumable projection that survives restarts without re-processing  |
| `StartTime`      | **Time-based replay.** Re-process events from a specific moment — useful for debugging, recovery, or rebuilding a projection from a known good point.                       | "Rebuild projection from start of today" or "replay the last hour" |

#### Scaling behavior

Ordered consumers are **ephemeral** — each instance creates its own independent consumer:

- **Multiple instances** — each instance receives **all** messages independently. There is no load balancing or exclusive delivery. This is by design — ordered consumers are meant for per-instance replay (e.g., building a local projection, populating a cache).
- **Single-instance deployments** — if you need exactly one handler processing ordered events across the cluster, deploy it as a singleton service (single replica).
- **Restart behavior** — depends on `deliverPolicy`. With `All` (default), the consumer replays from the beginning (within `max_age`). With `New`, it starts fresh — messages published while the instance was down are skipped.

> **Handlers must be idempotent** — multiple instances will process the same messages concurrently.

#### Comparison with workqueue events

|                  | Workqueue                          | Ordered                                 |
|------------------|------------------------------------|-----------------------------------------|
| Delivery         | At-least-once                      | At-most-once                            |
| Ordering         | Not guaranteed (parallel)          | Strict sequential                       |
| Parallelism      | Multiple instances (load-balanced) | All instances (independent replay)      |
| Retry on failure | Yes (`nak` → redeliver)            | No (continues)                          |
| DLQ support      | Yes                                | No                                      |
| Stream retention | Workqueue (delete on ack)          | Limits (delete by age/size)             |
| Use case         | Workload distribution              | Event sourcing, audit logs, projections |
| Publish prefix   | (none)                             | `ordered:`                              |

> **Note:** In nats.js v2.29.x, explicitly passing `DeliverPolicy.All` to an ordered consumer causes `consume()` to hang due to a residual `opt_start_seq` in the internal config. The transport works around this by omitting the field when `All` is configured — nats.js defaults to the same behavior. All other policies are passed through directly.

### JetstreamRecord Builder

Attach custom headers and per-request timeouts using the builder pattern:

```typescript
import { JetstreamRecordBuilder } from '@horizon-republic/nestjs-jetstream';

const record = new JetstreamRecordBuilder({ id: 1 })
  .setHeader('x-tenant', 'acme')
  .setTimeout(5000)
  .build();

// Custom message ID for JetStream deduplication
const idempotentRecord = new JetstreamRecordBuilder(orderData)
  .setMessageId(`order-${order.id}`)
  .build();

// Works with both send() and emit()
this.client.send('user.get', record);
this.client.emit('order.created', idempotentRecord);
```

**Reserved headers** (set automatically by the transport, cannot be overridden):

| Header             | Purpose                       |
|--------------------|-------------------------------|
| `x-correlation-id` | RPC request/response matching |
| `x-reply-to`       | JetStream RPC response inbox  |
| `x-error`          | RPC error response flag       |

Attempting to set a reserved header throws an error at build time.

**Additional transport headers** (set automatically, available in handlers via `RpcContext`):

| Header          | Purpose               |
|-----------------|-----------------------|
| `x-subject`     | Original NATS subject |
| `x-caller-name` | Sending service name  |

## Handler Context & Serialization

### RpcContext

Execution context available in all handlers via `@Ctx()`:

```typescript
import { Ctx, Payload, MessagePattern } from '@nestjs/microservices';
import { RpcContext } from '@horizon-republic/nestjs-jetstream';

@MessagePattern('user.get')
getUser(@Payload() data: GetUserDto, @Ctx() ctx: RpcContext) {
  const subject = ctx.getSubject();            // Full NATS subject
  const tenant = ctx.getHeader('x-tenant');     // Single header value
  const headers = ctx.getHeaders();            // All headers (MsgHdrs)
  const isJs = ctx.isJetStream();              // true for JetStream messages
  const msg = ctx.getMessage();                // Raw JsMsg | Msg (escape hatch)

  return this.userService.findOne(data.id);
}
```

**Available methods:**

| Method           | Returns                | Description                               |
|------------------|------------------------|-------------------------------------------|
| `getSubject()`   | `string`               | NATS subject the message was published to |
| `getHeader(key)` | `string \| undefined`  | Single header value by key                |
| `getHeaders()`   | `MsgHdrs \| undefined` | All NATS message headers                  |
| `isJetStream()`  | `boolean`              | Whether the message supports ack/nak/term |
| `getMessage()`   | `JsMsg \| Msg`         | Raw NATS message (escape hatch)           |

Available on both `@EventPattern` and `@MessagePattern` handlers.

### Custom Codec

The library uses JSON by default. Implement the `Codec` interface for any serialization format:

```typescript
import { Codec } from '@horizon-republic/nestjs-jetstream';
import { encode, decode } from '@msgpack/msgpack';

class MsgPackCodec implements Codec {
  encode(data: unknown): Uint8Array {
    return encode(data);
  }

  decode(data: Uint8Array): unknown {
    return decode(data);
  }
}
```

```typescript
// Global codec
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  codec: new MsgPackCodec(),
})

// Per-client override (falls back to global codec when omitted)
JetstreamModule.forFeature({
  name: 'legacy-service',
  codec: new JsonCodec(),
})
```

> All services communicating with each other **must use the same codec**. A codec mismatch results in decode errors (`term`, no redelivery).

## Operations

### Lifecycle Hooks

Subscribe to transport events for monitoring, alerting, or custom logic. Events without a registered hook are silently ignored — no default logging:

```typescript
import { JetstreamModule, TransportEvent } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  hooks: {
    [TransportEvent.Connect]: (server) => {
      console.log(`Connected to ${server}`);
    },
    [TransportEvent.Disconnect]: () => {
      metrics.increment('nats.disconnect');
    },
    [TransportEvent.Error]: (error, context) => {
      sentry.captureException(error, { extra: { context } });
    },
    [TransportEvent.RpcTimeout]: (subject, correlationId) => {
      metrics.increment('rpc.timeout', { subject });
    },
  },
})
```

**Available events:**

| Event              | Arguments                                   |
|--------------------|---------------------------------------------|
| `connect`          | `(server: string)`                          |
| `disconnect`       | `()`                                        |
| `reconnect`        | `(server: string)`                          |
| `error`            | `(error: Error, context?: string)`          |
| `rpcTimeout`       | `(subject: string, correlationId: string)`  |
| `messageRouted`    | `(subject: string, kind: 'rpc' \| 'event')` |
| `shutdownStart`    | `()`                                        |
| `shutdownComplete` | `()`                                        |
| `deadLetter`       | `(info: DeadLetterInfo)`                    |

#### Dead Letter Queue (DLQ)

When an event handler fails on every delivery attempt (`max_deliver`), the message becomes a "dead letter." By default, NATS terminates it silently. Configure `onDeadLetter` to intercept these messages:

```typescript
JetstreamModule.forRoot({
  name: 'my-service',
  servers: ['nats://localhost:4222'],
  onDeadLetter: async (info) => {
    // Persist to your DLQ store (database, S3, another queue, etc.)
    await dlqRepository.save({
      subject: info.subject,
      data: info.data,
      error: String(info.error),
      deliveryCount: info.deliveryCount,
      stream: info.stream,
      timestamp: info.timestamp,
    });
  },
});
```

**Behavior:**
- Hook is awaited before `msg.term()` — if it succeeds, the message is terminated
- If the hook throws, the message is `nak()`'d for retry (NATS redelivers it)
- `TransportEvent.DeadLetter` is emitted for observability regardless of the hook
- Applies only to events (workqueue + broadcast), not RPC

**With dependency injection (`forRootAsync`):**

```typescript
import { JETSTREAM_CONNECTION } from '@horizon-republic/nestjs-jetstream';

JetstreamModule.forRootAsync({
  name: 'my-service',
  imports: [DlqModule],
  inject: [DlqService, JETSTREAM_CONNECTION],
  useFactory: (dlqService: DlqService, connection: ConnectionProvider) => ({
    servers: ['nats://localhost:4222'],
    onDeadLetter: async (info) => {
      await dlqService.persist(info);
    },
  }),
});
```

### Health Checks

`JetstreamHealthIndicator` is automatically registered and exported by `forRoot()`. It checks NATS connection status and measures round-trip latency. `@nestjs/terminus` is **not required** — the indicator follows the Terminus API convention and can be used standalone.

> **Note:** `isHealthy()` throws a plain `Error` with attached status details rather than Terminus's `HealthCheckError`. Terminus will report the service as unhealthy, but the structured `{ status: 'down', server, latency }` details may not appear in the response body. For full Terminus formatting, use the `check()` method in a custom wrapper.

**With [@nestjs/terminus](https://docs.nestjs.com/recipes/terminus) (zero boilerplate):**

```typescript
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { JetstreamHealthIndicator } from '@horizon-republic/nestjs-jetstream';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private jetstream: JetstreamHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.jetstream.isHealthy(),
    ]);
  }
}
```

**Standalone (without Terminus):**

```typescript
const status = await this.jetstream.check();
// { connected: true, server: 'nats://localhost:4222', latency: 2 }
```

| Method            | Returns                            | Throws                             |
|-------------------|------------------------------------|------------------------------------|
| `check()`         | `JetstreamHealthStatus`            | Never                              |
| `isHealthy(key?)` | `{ [key]: { status: 'up', ... } }` | On unhealthy (Terminus convention) |

### Graceful Shutdown

The transport shuts down automatically via NestJS `onApplicationShutdown()`:

1. Stop accepting new messages (close subscriptions, stop consumers)
2. Drain and close NATS connection (waits for in-flight messages)
3. Safety timeout if drain takes too long

```typescript
JetstreamModule.forRoot({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  shutdownTimeout: 15_000,  // default: 10_000 ms
})
```

No manual shutdown code needed.

## Reference

### Edge Cases & Important Notes

#### Event handlers must be idempotent

Events use at-least-once delivery. If your handler throws, the message is `nak`'d and NATS redelivers it (up to `max_deliver` times, default 3). Design handlers to be safe for repeated execution.

#### RPC error handling

The transport fully supports NestJS `RpcException` and custom exception filters. Throw `RpcException` with any payload — it will be delivered to the caller as-is:

```typescript
import { RpcException } from '@nestjs/microservices';

@MessagePattern('user.update')
updateUser(@Payload() data: UpdateUserDto) {
  throw new RpcException({
    statusCode: 400,
    errors: [{ field: 'email', message: 'Already taken' }],
  });
}

// Caller receives the full error object:
this.client.send('user.update', data).subscribe({
  error: (err) => {
    // err = { statusCode: 400, errors: [{ field: 'email', message: 'Already taken' }] }
  },
});
```

In JetStream mode, failed RPC messages are `term`'d (not `nak`'d) to prevent duplicate side effects. The caller is responsible for implementing retry logic.

#### Fire-and-forget events

This library focuses on **reliable, persistent** event delivery via JetStream. If you need fire-and-forget (no persistence, no ack) for high-throughput scenarios, use the standard [NestJS NATS transport](https://docs.nestjs.com/microservices/nats) — it works perfectly alongside this library on the same NATS server.

#### Publisher-only mode

For services that only send messages (e.g., API gateways), disable consumer infrastructure:

```typescript
JetstreamModule.forRoot({
  name: 'api-gateway',
  servers: ['nats://localhost:4222'],
  consumer: false,  // no streams, consumers, or routers created
})
```

#### Broadcast stream is shared

All services share a single `broadcast-stream`. Each service creates its own durable consumer with `filter_subjects` matching only its registered broadcast patterns. Stream-level configuration (`broadcast.stream`) affects all services.

Broadcast consumers use the same ack/nak semantics as workqueue consumers. Because each service has an **isolated durable consumer**, a `nak` (retry) from one service only causes redelivery to that specific service — other consumers are unaffected. This gives broadcast **at-least-once delivery per consumer** with independent retry.

#### Connection failure behavior

If the initial NATS connection is refused, the module throws an `Error` immediately (fail fast). For transient disconnects after startup, NATS handles reconnection automatically and the `reconnect` hook fires.

#### Observable return values

Handlers can return Observables. The transport resolves on the **first emitted value** (or on completion if the Observable emits nothing):

```typescript
@MessagePattern('user.get')
getUser(@Payload() data: { id: number }): Observable<UserDto> {
  return this.userService.findById(data.id); // first value used as response
}

@EventPattern('order.created')
handleOrder(@Payload() data: OrderDto): Observable<void> {
  return this.pipeline.process(data); // ack after first emission or completion
}
```

#### Consumer self-healing

If a JetStream consumer's message iterator ends unexpectedly (e.g., NATS restart), the transport automatically re-establishes consumption with exponential backoff (100ms up to 30s). This is logged as a warning.

#### NATS header size

Custom headers are transmitted as NATS message headers. NATS has a default header size limit. If you're attaching large metadata, consider putting it in the message body instead.

### NATS Naming Conventions

The transport generates NATS subjects, streams, and consumers based on the service `name`:

| Resource           | Format                          | Example (`name: 'orders'`)                  |
|--------------------|---------------------------------|---------------------------------------------|
| Internal name      | `{name}__microservice`          | `orders__microservice`                      |
| RPC subject        | `{internal}.cmd.{pattern}`      | `orders__microservice.cmd.get.order`        |
| Event subject      | `{internal}.ev.{pattern}`       | `orders__microservice.ev.order.created`     |
| Broadcast subject  | `broadcast.{pattern}`           | `broadcast.config.updated`                  |
| Ordered subject    | `{internal}.ordered.{pattern}`  | `orders__microservice.ordered.order.status` |
| Event stream       | `{internal}_ev-stream`          | `orders__microservice_ev-stream`            |
| Command stream     | `{internal}_cmd-stream`         | `orders__microservice_cmd-stream`           |
| Broadcast stream   | `broadcast-stream`              | `broadcast-stream`                          |
| Ordered stream     | `{internal}_ordered-stream`     | `orders__microservice_ordered-stream`       |
| Event consumer     | `{internal}_ev-consumer`        | `orders__microservice_ev-consumer`          |
| Command consumer   | `{internal}_cmd-consumer`       | `orders__microservice_cmd-consumer`         |
| Broadcast consumer | `{internal}_broadcast-consumer` | `orders__microservice_broadcast-consumer`   |

### Default Stream & Consumer Configs

All defaults can be overridden via `events`, `broadcast`, `ordered`, or `rpc` options.

<details>
<summary><strong>Event Stream</strong></summary>

| Property             | Value      |
|----------------------|------------|
| Retention            | Workqueue  |
| Storage              | File       |
| Replicas             | 1          |
| Max consumers        | 100        |
| Max message size     | 10 MB      |
| Max messages/subject | 5,000,000  |
| Max messages         | 50,000,000 |
| Max bytes            | 5 GB       |
| Max age              | 7 days     |
| Duplicate window     | 2 minutes  |

</details>

<details>
<summary><strong>Command Stream (JetStream RPC only)</strong></summary>

| Property             | Value      |
|----------------------|------------|
| Retention            | Workqueue  |
| Storage              | File       |
| Replicas             | 1          |
| Max consumers        | 50         |
| Max message size     | 5 MB       |
| Max messages/subject | 100,000    |
| Max messages         | 1,000,000  |
| Max bytes            | 100 MB     |
| Max age              | 3 minutes  |
| Duplicate window     | 30 seconds |

</details>

<details>
<summary><strong>Broadcast Stream</strong></summary>

| Property             | Value      |
|----------------------|------------|
| Retention            | Limits     |
| Storage              | File       |
| Replicas             | 1          |
| Max consumers        | 200        |
| Max message size     | 10 MB      |
| Max messages/subject | 1,000,000  |
| Max messages         | 10,000,000 |
| Max bytes            | 2 GB       |
| Max age              | 1 day      |
| Duplicate window     | 2 minutes  |

</details>

<details>
<summary><strong>Ordered Stream</strong></summary>

| Property             | Value      |
|----------------------|------------|
| Retention            | Limits     |
| Storage              | File       |
| Replicas             | 1          |
| Max consumers        | 100        |
| Max message size     | 10 MB      |
| Max messages/subject | 5,000,000  |
| Max messages         | 50,000,000 |
| Max bytes            | 5 GB       |
| Max age              | 1 day      |
| Duplicate window     | 2 minutes  |

> Ordered consumers are **ephemeral** — no durable consumer config. Delivery policy and other consumer-level settings are configured via `ordered.deliverPolicy` etc.

</details>

<details>
<summary><strong>Consumer Configs</strong></summary>

**Event consumer:**

| Property        | Value      |
|-----------------|------------|
| Ack wait        | 10 seconds |
| Max deliver     | 3          |
| Max ack pending | 100        |

**Command consumer (JetStream RPC):**

| Property        | Value     |
|-----------------|-----------|
| Ack wait        | 5 minutes |
| Max deliver     | 1         |
| Max ack pending | 100       |

**Broadcast consumer:**

| Property        | Value      |
|-----------------|------------|
| Ack wait        | 10 seconds |
| Max deliver     | 3          |
| Max ack pending | 100        |

</details>

### API Reference

#### Exports

```typescript
// Module
JetstreamModule

// Client
JetstreamClient
JetstreamRecord
JetstreamRecordBuilder

// Server
JetstreamStrategy

// Codec
JsonCodec

// Context
RpcContext

// Hooks
EventBus
TransportEvent

// Constants
JETSTREAM_OPTIONS
JETSTREAM_CONNECTION
JETSTREAM_CODEC
JETSTREAM_EVENT_BUS
JetstreamHeader
getClientToken
nanos

// Types
Codec
DeadLetterInfo
JetstreamModuleOptions
JetstreamModuleAsyncOptions
JetstreamFeatureOptions
OrderedEventOverrides
RpcConfig
StreamConsumerOverrides
TransportHooks
```

#### Helper: `nanos(ms)`

Convert milliseconds to nanoseconds (required by NATS JetStream config):

```typescript
import { nanos } from '@horizon-republic/nestjs-jetstream';

// Use in stream/consumer overrides
events: {
  stream: { max_age: nanos(3 * 24 * 60 * 60 * 1000) },  // 3 days
  consumer: { ack_wait: nanos(30_000) },                   // 30s
}
```

## Roadmap

### v3.0.0

- **Multiple connections** — `connectionName` parameter in `forRoot`/`forFeature` to support connecting to different NATS instances from the same service (e.g., multi-region, domain separation)
- **Dedicated documentation site** — move from README to a structured documentation platform

Have a feature request? [Open a discussion](https://github.com/HorizonRepublic/nestjs-jetstream/discussions).

## Development

### Testing

The project uses [Vitest](https://vitest.dev/) with two test suites configured as [projects](https://vitest.dev/guide/workspace):

```bash
# Unit tests (no external dependencies)
pnpm test

# Integration tests (requires a running NATS server with JetStream)
pnpm test:integration

# Both suites sequentially
pnpm test:all

# Unit tests in watch mode
pnpm test:watch

# Unit tests with coverage report
pnpm test:cov
```

#### Running NATS locally

Integration tests require a NATS server with JetStream enabled:

```bash
docker run -d --name nats -p 4222:4222 nats:latest -js
```

#### Writing tests

- Use `sut` (system under test) for the main instance
- Use `createMock<T>()` from `@golevelup/ts-vitest` for mocking
- Follow Given-When-Then structure with comments
- Order: happy path → edge cases → error cases
- Always include `afterEach(vi.resetAllMocks)`

### Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

[MIT](./LICENSE)

## Links

- [NATS JetStream Documentation](https://docs.nats.io/nats-concepts/jetstream)
- [NestJS Microservices](https://docs.nestjs.com/microservices/basics)
- [GitHub Repository](https://github.com/HorizonRepublic/nestjs-jetstream)
- [npm Package](https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream)
- [Report bugs](https://github.com/HorizonRepublic/nestjs-jetstream/issues)
- [Discussions](https://github.com/HorizonRepublic/nestjs-jetstream/discussions)