---
sidebar_position: 5
sidebar_label: "Migrate from built-in NATS"
title: "How to migrate from @nestjs/microservices NATS to JetStream"
description: "Step-by-step migration from the built-in NestJS NATS transport (@nestjs/microservices) to @horizon-republic/nestjs-jetstream, keeping your existing handlers."
schema:
  type: Article
  headline: "How to migrate from @nestjs/microservices NATS to JetStream"
  description: "Step-by-step migration from the built-in NestJS NATS transport to durable JetStream-backed delivery."
  datePublished: "2026-03-26"
  dateModified: "2026-10-23"
---

# How to migrate from `@nestjs/microservices` NATS to JetStream

> **Use when:** you are replacing `Transport.NATS` from `/microservices`.
> **You get:** five steps that keep your handlers, plus the acknowledgment semantics that change underneath.

Replacing the built-in NestJS NATS transport (`Transport.NATS` from `@nestjs/microservices`) with `@horizon-republic/nestjs-jetstream` is configuration work: your `ClientProxy` already speaks NATS.

You will end up with durable delivery and automatic retries, plus dead letter handling and W3C trace context, all behind the same `@EventPattern` and `@MessagePattern` handlers you already have.

:::tip Already on this library?
[Upgrading](/docs/reference/upgrading) lists what changes between its versions.
:::

## What changes

The semantic shift is from at-most-once to at-least-once delivery:

- **Delivery.** Built-in NATS is fire-and-forget, so a message with no subscriber listening is gone. JetStream persists every event in a stream, and messages survive restarts.
- **Retention.** Built-in has no retention. JetStream keeps messages in a stream until acked (workqueue) or until the retention window expires.
- **Replay.** Built-in does not support replay. JetStream consumers can be created to catch up on history.
- **Retries.** Built-in does not retry. JetStream redelivers a message until the handler acks or `max_deliver` is exhausted.
- **Dead letters.** Built-in silently drops failed messages. JetStream provides a configurable dead-letter flow ([Dead Letter Queue](/docs/guides/dead-letter-queue)).
- **Decorators.** Unchanged. `@EventPattern` and `@MessagePattern` work identically.

## Step 1: Install the library

```bash npm2yarn
npm install @horizon-republic/nestjs-jetstream
```

The NATS client packages come with it. Keep `@nestjs/microservices`: it is a peer dependency, and the decorators and `ClientProxy` still come from it.

## Step 2: Replace module registration

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
    // Once in your root module, creates the connection + consumer infrastructure
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

## Step 3: Keep your handlers

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

## Step 4: Replace client injection

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

## Step 5: Adjust for acknowledgment semantics

JetStream is **at-least-once**. A message may be redelivered after a handler throws or a pod restarts mid-execution. Make handlers idempotent:

- Use a unique identifier from the payload (e.g., `orderId`) to deduplicate.
- For commands that produce side effects (charge a card, send an email), check whether the side effect already happened before doing it again.
- See [Idempotency](/docs/patterns/events#idempotency) in the events pattern for concrete techniques.

## What you gain

Messages survive restarts and are retried up to `max_deliver`, then kept in a [dead-letter stream](/docs/guides/dead-letter-queue). [Health checks](/docs/guides/health-checks), [graceful shutdown](/docs/guides/graceful-shutdown), [tracing](/docs/observability/tracing) and [metrics](/docs/observability/metrics) are available behind the same module. [Why JetStream?](/docs/getting-started/why-jetstream) has the full comparison.

## See also

- [Installation](/docs/getting-started/installation): setup requirements
- [Module Configuration](/docs/reference/module-configuration): full options reference
- [Quick Start](/docs/getting-started/quick-start): first handler in 5 minutes
- [Upgrading](/docs/reference/upgrading): changes between versions of this library
