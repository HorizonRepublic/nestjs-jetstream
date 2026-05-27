---
sidebar_position: 5
sidebar_label: "Migrate from built-in NATS"
title: "How to migrate from @nestjs/microservices NATS to JetStream"
description: "Step-by-step migration from the built-in NestJS NATS transport (@nestjs/microservices) to @horizon-republic/nestjs-jetstream — durable delivery, automatic retries, and dead letter handling."
schema:
  type: Article
  headline: "How to migrate from @nestjs/microservices NATS to JetStream"
  description: "Step-by-step migration from the built-in NestJS NATS transport to durable JetStream-backed delivery."
  datePublished: "2026-03-26"
  dateModified: "2026-05-27"
---

# How to migrate from `@nestjs/microservices` NATS to JetStream

This guide walks through replacing the built-in NestJS NATS transport (`@nestjs/microservices` package, `Transport.NATS`) with `@horizon-republic/nestjs-jetstream`. Your `ClientProxy` already talks to NATS — switching to JetStream is mostly configuration.

You will end up with durable delivery, automatic retries, dead letter handling, and W3C trace context for the same `@EventPattern` / `@MessagePattern` handlers you already have.

:::tip Already using this library and upgrading to a newer version?
See the [Release Notes](/docs/reference/release-notes) instead. This guide covers the one-time switch from `@nestjs/microservices`.
:::

## What changes

The semantic shift is from at-most-once to at-least-once delivery:

- **Delivery.** Built-in NATS is fire-and-forget; messages are lost if no subscriber is listening. JetStream persists every event in a stream so messages survive restarts.
- **Retention.** Built-in has no retention. JetStream keeps messages in a stream until acked (workqueue) or until the retention window expires.
- **Replay.** Built-in does not support replay. JetStream consumers can be created to catch up on history.
- **Retries.** Built-in does not retry. JetStream redelivers a message until the handler acks or `max_deliver` is exhausted.
- **Dead letters.** Built-in silently drops failed messages. JetStream provides a configurable dead-letter flow ([Dead Letter Queue](/docs/guides/dead-letter-queue)).
- **Decorators.** Unchanged. `@EventPattern` and `@MessagePattern` work identically.

## Step 1 — Install the library

```bash
npm install @horizon-republic/nestjs-jetstream @nats-io/transport-node @nats-io/jetstream
```

You can remove `@nestjs/microservices` if no other transport (Redis, RabbitMQ, Kafka) is in use.

## Step 2 — Replace module registration

Before:

```typescript
import { Transport, ClientsModule } from '@nestjs/microservices';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        transport: Transport.NATS,
        options: { servers: ['nats://localhost:4222'] },
      },
    ]),
  ],
})
export class AppModule {}
```

After:

```typescript
import { JetstreamModule } from '@horizon-republic/nestjs-jetstream';

@Module({
  imports: [
    // Once in your root module — creates the connection + consumer infrastructure
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['nats://localhost:4222'],
    }),

    // Per target service, where you publish to
    JetstreamModule.forFeature({ name: 'payments' }),
  ],
})
export class AppModule {}
```

The `name` field is the service identity used to derive stream, consumer, and subject names. See [Naming Conventions](/docs/reference/naming-conventions) for the rules.

## Step 3 — Keep your handlers

No changes to handler signatures. `@EventPattern` and `@MessagePattern` work identically.

```typescript
import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

@Controller()
export class OrdersController {
  @EventPattern('order.created')
  handleOrderCreated(@Payload() data: { orderId: string }) {
    // Same code as before. Throws here will trigger JetStream retries.
  }

  @MessagePattern('order.get')
  getOrder(@Payload() data: { id: string }) {
    return { id: data.id, status: 'shipped' };
  }
}
```

## Step 4 — Replace client injection

Before:

```typescript
import { ClientProxy } from '@nestjs/microservices';

constructor(@Inject('NATS_SERVICE') private readonly client: ClientProxy) {}
```

After:

```typescript
import { ClientProxy } from '@nestjs/microservices';
import { getClientToken } from '@horizon-republic/nestjs-jetstream';

constructor(@Inject(getClientToken('payments')) private readonly client: ClientProxy) {}
```

`client.emit()` and `client.send()` keep their existing signatures.

## Step 5 — Adjust for acknowledgment semantics

JetStream is **at-least-once**. A message may be redelivered after a handler throws or a pod restarts mid-execution. Make handlers idempotent:

- Use a unique identifier from the payload (e.g., `orderId`) to deduplicate.
- For commands that produce side effects (charge a card, send an email), check whether the side effect already happened before doing it again.
- See [Idempotency](/docs/patterns/events#idempotency) in the events pattern for concrete techniques.

## What you gain

After migration, you get these capabilities for free:

- Messages survive NATS server restarts.
- Failed messages are automatically retried up to `max_deliver`.
- Dead letter handling for exhausted retries — see [Dead Letter Queue](/docs/guides/dead-letter-queue).
- Health checks with RTT monitoring — see [Health Checks](/docs/guides/health-checks).
- Graceful shutdown with message drain — see [Graceful Shutdown](/docs/guides/graceful-shutdown).
- Broadcast fan-out to all service instances — see [Broadcast Events](/docs/patterns/broadcast).
- Ordered sequential delivery mode — see [Ordered Events](/docs/patterns/ordered-events).
- W3C trace context end-to-end — see [Distributed Tracing](/docs/observability/tracing).
- Prometheus metrics out of the box — see [Prometheus Metrics](/docs/observability/metrics).

## See also

- [Installation](/docs/getting-started/installation) — setup requirements
- [Module Configuration](/docs/reference/module-configuration) — full options reference
- [Quick Start](/docs/getting-started/quick-start) — first handler in 5 minutes
- [Release Notes](/docs/reference/release-notes) — version-by-version changelog
