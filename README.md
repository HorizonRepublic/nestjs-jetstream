# @horizon-republic/nestjs-jetstream

A production-grade NestJS transport for NATS JetStream with built-in support for **Events**, **Broadcast**, and **RPC** messaging patterns.

[![npm version](https://img.shields.io/npm/v/@horizon-republic/nestjs-jetstream.svg)](https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream)
[![codecov](https://codecov.io/github/HorizonRepublic/nestjs-jetstream/graph/badge.svg?token=40IPSWFMT4)](https://codecov.io/github/HorizonRepublic/nestjs-jetstream)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Module Configuration](#module-configuration)
  - [forRoot / forRootAsync](#forroot--forrootasync)
  - [forFeature](#forfeature)
  - [Full Options Reference](#full-options-reference)
- [RPC (Request/Reply)](#rpc-requestreply)
  - [Core Mode (Default)](#core-mode-default)
  - [JetStream Mode](#jetstream-mode)
- [Events](#events)
  - [Workqueue Events](#workqueue-events)
  - [Broadcast Events](#broadcast-events)
- [JetstreamRecord Builder](#jetstreamrecord-builder)
- [Custom Codec](#custom-codec)
- [RpcContext](#rpccontext)
- [Lifecycle Hooks](#lifecycle-hooks)
- [Graceful Shutdown](#graceful-shutdown)
- [Edge Cases & Important Notes](#edge-cases--important-notes)
- [NATS Naming Conventions](#nats-naming-conventions)
- [Default Stream & Consumer Configs](#default-stream--consumer-configs)
- [API Reference](#api-reference)
- [Contributing](#contributing)
- [License](#license)
- [Links](#links)

## Features

- **Two RPC modes** — NATS Core request/reply (lowest latency) or JetStream-persisted commands
- **At-least-once event delivery** — messages acked after handler success, redelivered on failure
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
@nestjs/common        ^11.0.0
@nestjs/core          ^11.0.0
@nestjs/microservices ^11.0.0
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

  /** Transport lifecycle hook handlers. Unset hooks fall back to NestJS Logger. */
  hooks?: Partial<TransportHooks>;

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

## RPC (Request/Reply)

### Core Mode (Default)

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

| Scenario | Result |
|----------|--------|
| Handler success | Response returned to caller |
| Handler throws | Error response returned to caller |
| No handler running | Client times out |
| Decode error | Error response returned to caller |

### JetStream Mode

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

## Events

### Workqueue Events

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

### Broadcast Events

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

## JetstreamRecord Builder

Attach custom headers and per-request timeouts using the builder pattern:

```typescript
import { JetstreamRecordBuilder } from '@horizon-republic/nestjs-jetstream';

const record = new JetstreamRecordBuilder({ id: 1 })
  .setHeader('x-trace-id', 'abc-123')
  .setHeader('x-tenant', 'acme')
  .setTimeout(5000)
  .build();

// Works with both send() and emit()
this.client.send('user.get', record);
this.client.emit('user.created', record);
```

**Reserved headers** (set automatically by the transport, cannot be overridden):

| Header             | Purpose                       |
|--------------------|-------------------------------|
| `x-correlation-id` | RPC request/response matching |
| `x-reply-to`       | JetStream RPC response inbox  |
| `x-message-id`     | Deduplication                 |

Attempting to set a reserved header throws an error at build time.

**Additional transport headers** (set automatically, available in handlers):

| Header          | Purpose                                     |
|-----------------|---------------------------------------------|
| `x-subject`     | Original NATS subject                       |
| `x-caller-name` | Sending service name                        |
| `x-request-id`  | Available for user-defined request tracking |
| `x-trace-id`    | Available for distributed tracing           |
| `x-span-id`     | Available for distributed tracing           |

## Custom Codec

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

## RpcContext

Execution context available in all handlers via `@Ctx()`:

```typescript
import { Ctx, Payload, MessagePattern } from '@nestjs/microservices';
import { RpcContext } from '@horizon-republic/nestjs-jetstream';

@MessagePattern('user.get')
getUser(@Payload() data: GetUserDto, @Ctx() ctx: RpcContext) {
  const subject = ctx.getSubject();            // Full NATS subject
  const traceId = ctx.getHeader('x-trace-id'); // Single header value
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

## Lifecycle Hooks

Subscribe to transport events for monitoring, alerting, or custom logic:

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

| Event              | Arguments                                   | Default (no hook) |
|--------------------|---------------------------------------------|-------------------|
| `connect`          | `(server: string)`                          | `Logger.log`      |
| `disconnect`       | `()`                                        | `Logger.warn`     |
| `reconnect`        | `(server: string)`                          | `Logger.log`      |
| `error`            | `(error: Error, context?: string)`          | `Logger.error`    |
| `rpcTimeout`       | `(subject: string, correlationId: string)`  | `Logger.warn`     |
| `messageRouted`    | `(subject: string, kind: 'rpc' \| 'event')` | `Logger.debug`    |
| `shutdownStart`    | `()`                                        | `Logger.log`      |
| `shutdownComplete` | `()`                                        | `Logger.log`      |

## Graceful Shutdown

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

## Edge Cases & Important Notes

### Event handlers must be idempotent

Events use at-least-once delivery. If your handler throws, the message is `nak`'d and NATS redelivers it (up to `max_deliver` times, default 3). Design handlers to be safe for repeated execution.

### RPC error handling

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

### Fire-and-forget events

This library focuses on **reliable, persistent** event delivery via JetStream. If you need fire-and-forget (no persistence, no ack) for high-throughput scenarios, use the standard [NestJS NATS transport](https://docs.nestjs.com/microservices/nats) — it works perfectly alongside this library on the same NATS server.

### Publisher-only mode

For services that only send messages (e.g., API gateways), disable consumer infrastructure:

```typescript
JetstreamModule.forRoot({
  name: 'api-gateway',
  servers: ['nats://localhost:4222'],
  consumer: false,  // no streams, consumers, or routers created
})
```

### Broadcast stream is shared

All services share a single `broadcast-stream`. Each service creates its own durable consumer with `filter_subjects` matching only its registered broadcast patterns. Stream-level configuration (`broadcast.stream`) affects all services.

### Connection failure behavior

If the initial NATS connection is refused, the module throws a `RuntimeException` immediately (fail fast). For transient disconnects after startup, NATS handles reconnection automatically and the `reconnect` hook fires.

### Observable return values

Handlers can return Observables. The transport takes the **first emitted value** for RPC responses and awaits completion for events:

```typescript
@MessagePattern('user.get')
getUser(@Payload() data: { id: number }): Observable<UserDto> {
  return this.userService.findById(data.id); // first value used as response
}

@EventPattern('order.created')
handleOrder(@Payload() data: OrderDto): Observable<void> {
  return this.pipeline.process(data); // awaits completion before ack
}
```

### Consumer self-healing

If a JetStream consumer's message iterator ends unexpectedly (e.g., NATS restart), the transport automatically re-establishes consumption after a 100ms delay. This is logged as a warning.

### NATS header size

Custom headers are transmitted as NATS message headers. NATS has a default header size limit. If you're attaching large metadata, consider putting it in the message body instead.

## NATS Naming Conventions

The transport generates NATS subjects, streams, and consumers based on the service `name`:

| Resource           | Format                          | Example (`name: 'orders'`)                |
|--------------------|---------------------------------|-------------------------------------------|
| Internal name      | `{name}__microservice`          | `orders__microservice`                    |
| RPC subject        | `{internal}.cmd.{pattern}`      | `orders__microservice.cmd.get.order`      |
| Event subject      | `{internal}.ev.{pattern}`       | `orders__microservice.ev.order.created`   |
| Broadcast subject  | `broadcast.{pattern}`           | `broadcast.config.updated`                |
| Event stream       | `{internal}_ev-stream`          | `orders__microservice_ev-stream`          |
| Command stream     | `{internal}_cmd-stream`         | `orders__microservice_cmd-stream`         |
| Broadcast stream   | `broadcast-stream`              | `broadcast-stream`                        |
| Event consumer     | `{internal}_ev-consumer`        | `orders__microservice_ev-consumer`        |
| Command consumer   | `{internal}_cmd-consumer`       | `orders__microservice_cmd-consumer`       |
| Broadcast consumer | `{internal}_broadcast-consumer` | `orders__microservice_broadcast-consumer` |

## Default Stream & Consumer Configs

All defaults can be overridden via `events`, `broadcast`, or `rpc` options.

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

## API Reference

### Exports

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
JetstreamModuleOptions
JetstreamModuleAsyncOptions
JetstreamFeatureOptions
RpcConfig
StreamConsumerOverrides
TransportHooks
```

### Helper: `nanos(ms)`

Convert milliseconds to nanoseconds (required by NATS JetStream config):

```typescript
import { nanos } from '@horizon-republic/nestjs-jetstream';

// Use in stream/consumer overrides
events: {
  stream: { max_age: nanos(3 * 24 * 60 * 60 * 1000) },  // 3 days
  consumer: { ack_wait: nanos(30_000) },                   // 30s
}
```

## Contributing

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
