---
sidebar_position: 2
title: Quick Start
schema:
  type: Article
  headline: "Quick Start"
  description: "Complete working example in four steps: register the module, connect the transport, define handlers, and send messages."
  datePublished: "2026-03-21"
  dateModified: "2026-03-21"
---

# Quick Start

This guide walks you through a complete working example in four steps: register the module, connect the transport, define handlers, and send messages.

By the end, you'll have a NestJS application that sends and receives JetStream messages.

:::info Prerequisites
Make sure you have [installed the library](/docs/getting-started/installation) and have a NATS server running with JetStream enabled.
:::

## 1. Register the module

The library uses a **root + feature** registration pattern:

- `forRoot()` initializes the NATS connection and infrastructure (once, in the root module)
- `forFeature()` creates a lightweight client for sending messages to a target service

```typescript title="src/app.module.ts"
import { Module } from '@nestjs/common';
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';
import { OrdersController } from './orders.controller';
import { GatewayController } from './gateway.controller';

@Module({
  imports: [
    // Global setup — creates NATS connection, streams, consumers
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['nats://localhost:4222'],
    }),

    // Client for sending messages to the "orders" service
    JetstreamModule.forFeature({ name: 'orders' }),
  ],
  controllers: [OrdersController, GatewayController],
})
export class AppModule {}
```

:::tip Naming matters
The `name` in `forRoot()` identifies **this** service. The `name` in `forFeature()` identifies the **target** service you want to send messages to. When a service sends messages to itself, the two names are the same.
:::

## 2. Connect the transport

In your `main.ts`, resolve the `JetstreamStrategy` from the DI container and connect it as a microservice transport:

```typescript title="src/main.ts"
import { NestFactory } from '@nestjs/core';
import { JetstreamStrategy } from '@horizon-republic/nestjs-jetstream';
import { AppModule } from './app.module';

const bootstrap = async () => {
  const app = await NestFactory.create(AppModule);

  // Retrieve the strategy instance from the DI container
  app.connectMicroservice(
    { strategy: app.get(JetstreamStrategy) },
    { inheritAppConfig: true },
  );

  await app.startAllMicroservices();
  await app.listen(3000);
};

void bootstrap();
```

:::warning Don't instantiate the strategy manually
Unlike other NestJS transports, you must **not** create the strategy with `new JetstreamStrategy()`. The module creates it through DI with all required dependencies. Always use `app.get(JetstreamStrategy)` to retrieve it.
:::

## 3. Define handlers

Use standard NestJS decorators to define message handlers:

```typescript title="src/orders.controller.ts"
import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { RpcContext } from '@horizon-republic/nestjs-jetstream';

@Controller()
export class OrdersController {
  private readonly logger = new Logger(OrdersController.name);

  /**
   * Workqueue event handler.
   * Each message is delivered to exactly one instance (load-balanced).
   * Acked automatically after successful execution.
   */
  @EventPattern('order.created')
  handleOrderCreated(@Payload() data: { orderId: number; total: number }): void {
    this.logger.log(`Processing order ${data.orderId}, total: $${data.total}`);
    // If this throws, the message is nak'd and redelivered (up to max_deliver times)
  }

  /**
   * Broadcast event handler.
   * Every running instance receives this message.
   */
  @EventPattern('config.updated', { broadcast: true })
  handleConfigUpdated(@Payload() data: { key: string; value: string }): void {
    this.logger.log(`Config changed: ${data.key} = ${data.value}`);
  }

  /**
   * RPC handler.
   * Return value is sent back to the caller.
   */
  @MessagePattern('order.get')
  getOrder(
    @Payload() data: { id: number },
    @Ctx() ctx: RpcContext,
  ): { id: number; status: string } {
    this.logger.log(`RPC: order.get (id=${data.id}), subject: ${ctx.getSubject()}`);
    return { id: data.id, status: 'shipped' };
  }
}
```

**Handler types at a glance:**

| Decorator | Pattern prefix | Delivery | Return value |
|---|---|---|---|
| `@EventPattern('...')` | _(none)_ | One instance (workqueue) | Ignored |
| `@EventPattern('...', { broadcast: true })` | _(none)_ | All instances (fan-out) | Ignored |
| `@EventPattern('...', { ordered: true })` | _(none)_ | Strict sequential replay | Ignored |
| `@MessagePattern('...')` | _(none)_ | One instance (load-balanced) | Sent as response |

## 4. Send messages

Inject the client by the service name you used in `forFeature()` and use the standard `ClientProxy` API:

```typescript title="src/gateway.controller.ts"
import { Controller, Get, Inject, Param } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Observable } from 'rxjs';

@Controller('orders')
export class GatewayController {
  constructor(
    @Inject('orders') private readonly client: ClientProxy,
  ) {}

  /** Emit a workqueue event (fire-and-forget, at-least-once delivery). */
  @Get('create')
  createOrder(): Observable<void> {
    return this.client.emit('order.created', { orderId: 42, total: 99.99 });
  }

  /** Emit a broadcast event (all service instances receive it). */
  @Get('broadcast')
  broadcastConfig(): Observable<void> {
    return this.client.emit('broadcast:config.updated', {
      key: 'maintenance',
      value: 'true',
    });
  }

  /** Send an RPC command and wait for a response. */
  @Get(':id')
  getOrder(@Param('id') id: string): Observable<{ id: number; status: string }> {
    return this.client.send('order.get', { id: Number(id) });
  }
}
```

**Key differences between `emit` and `send`:**

| Method | Purpose | Delivery guarantee | Response |
|---|---|---|---|
| `client.emit(pattern, data)` | Fire-and-forget events | At-least-once (JetStream) | `Observable<void>` |
| `client.send(pattern, data)` | Request/reply RPC | Depends on RPC mode | `Observable<TResponse>` |

:::info Broadcast prefix
To send a broadcast event, prefix the pattern with `broadcast:` when calling `emit()`. On the handler side, use `{ broadcast: true }` in the decorator extras — no prefix needed.
:::

## Test it

Start the application and trigger some messages:

```bash
# Start the app
npm run start:dev

# Send a workqueue event
curl http://localhost:3000/orders/create

# Send a broadcast event
curl http://localhost:3000/orders/broadcast

# Send an RPC command
curl http://localhost:3000/orders/42
```

## What's next?

- [**Module Configuration**](/docs/getting-started/module-configuration) — learn about all configuration options, async setup, and advanced connection settings
- [**RPC Patterns**](/docs/patterns/rpc) — deep dive into Core vs JetStream RPC modes
- [**Events & Broadcast**](/docs/patterns/events) — workqueue events, broadcast fan-out, and ordered events
- [**Record Builder**](/docs/guides/record-builder) — attach custom headers and per-message timeouts
