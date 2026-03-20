---
sidebar_position: 2
title: "Handler Context"
---

# Handler Context

Every `@EventPattern` and `@MessagePattern` handler can inject `RpcContext` to access message metadata: the NATS subject, headers, and the raw underlying message. This works identically for both event and RPC handlers.

## Injecting the context

Use the standard NestJS `@Ctx()` decorator:

```typescript
import { Controller } from '@nestjs/common';
import { EventPattern, Payload, Ctx } from '@nestjs/microservices';
import { RpcContext } from '@horizon-republic/nestjs-jetstream';

@Controller()
export class OrdersController {
  @EventPattern('order.created')
  async handleOrderCreated(
    @Payload() data: OrderCreatedDto,
    @Ctx() ctx: RpcContext,
  ) {
    const subject = ctx.getSubject();
    const tenant = ctx.getHeader('x-tenant');
    // ...
  }
}
```

## Methods reference

| Method | Return type | Description |
|---|---|---|
| `getSubject()` | `string` | The NATS subject this message was published to |
| `getHeader(key)` | `string \| undefined` | Value of a single header, or `undefined` if missing |
| `getHeaders()` | `MsgHdrs \| undefined` | All NATS message headers (the raw nats.js `MsgHdrs` object) |
| `isJetStream()` | `boolean` | Type guard -- returns `true` when the message is a JetStream message |
| `getMessage()` | `JsMsg \| Msg` | The raw NATS message (type depends on transport mode) |

## Extracting custom headers

Headers set via [`JetstreamRecordBuilder.setHeader()`](./record-builder.md) are available through `getHeader()`:

```typescript title="Publisher"
const record = new JetstreamRecordBuilder(data)
  .setHeader('x-tenant', 'acme')
  .setHeader('x-trace-id', crypto.randomUUID())
  .build();

await lastValueFrom(this.client.emit('order.created', record));
```

```typescript title="Handler"
@EventPattern('order.created')
async handleOrderCreated(
  @Payload() data: OrderCreatedDto,
  @Ctx() ctx: RpcContext,
) {
  const tenant = ctx.getHeader('x-tenant');     // 'acme'
  const traceId = ctx.getHeader('x-trace-id');  // uuid string
  const missing = ctx.getHeader('x-unknown');    // undefined
}
```

The transport-managed headers are also accessible:

```typescript
const subject = ctx.getHeader('x-subject');       // original NATS subject
const caller = ctx.getHeader('x-caller-name');    // sending service name
```

## The `isJetStream()` type guard

`RpcContext` can wrap either a JetStream message (`JsMsg`) or a Core NATS message (`Msg`), depending on how the handler was invoked. The `isJetStream()` method is a TypeScript type guard that narrows the return type of `getMessage()`:

```typescript
@EventPattern('order.created')
async handleOrderCreated(
  @Payload() data: OrderCreatedDto,
  @Ctx() ctx: RpcContext,
) {
  if (ctx.isJetStream()) {
    // TypeScript knows getMessage() returns JsMsg here
    const msg = ctx.getMessage();

    console.log('Stream:', msg.info.stream);
    console.log('Sequence:', msg.seq);
    console.log('Redelivered:', msg.redelivered);
    console.log('Delivery count:', msg.info.redeliveryCount);
  }
}
```

Without the guard, `getMessage()` returns `JsMsg | Msg` and JetStream-specific properties are not available.

:::info When is it not JetStream?
The `isJetStream()` check is primarily useful when writing code that must work across both Core RPC mode (where handlers receive `Msg`) and JetStream mode (where handlers receive `JsMsg`). If your application uses JetStream exclusively, the check is still good practice for type safety.
:::

## Available on both pattern types

The context works identically for events and RPC:

```typescript
// Event handler
@EventPattern('order.created')
async handleEvent(@Payload() data: any, @Ctx() ctx: RpcContext) {
  const subject = ctx.getSubject();
  const tenant = ctx.getHeader('x-tenant');
}

// RPC handler
@MessagePattern('get.order')
async handleRpc(@Payload() data: any, @Ctx() ctx: RpcContext) {
  const subject = ctx.getSubject();
  const tenant = ctx.getHeader('x-tenant');
  return this.orderService.findOne(data.id);
}
```

## Accessing the raw NATS message

For advanced use cases, `getMessage()` gives you direct access to the underlying nats.js message object. This is an escape hatch -- prefer the typed accessors when possible.

```typescript
@EventPattern('order.created')
async handleOrderCreated(
  @Payload() data: OrderCreatedDto,
  @Ctx() ctx: RpcContext,
) {
  if (ctx.isJetStream()) {
    const msg = ctx.getMessage();

    // Access JetStream delivery metadata
    console.log('Stream sequence:', msg.seq);
    console.log('Consumer sequence:', msg.info.streamSequence);
    console.log('Pending messages:', msg.info.pending);

    // Manual ack/nak (normally handled by the transport)
    // Only use this if you need to override default behavior
    msg.ack();
  }
}
```

:::warning Manual acknowledgment
The transport automatically acknowledges messages after successful handler execution and naks on failure. Calling `msg.ack()` or `msg.nak()` manually can interfere with the transport's delivery guarantees. Only do this if you fully understand the implications.
:::

## Next steps

- [Record Builder & Deduplication](./record-builder.md) -- set custom headers and message IDs on the publisher side
- [Custom Codec](./custom-codec.md) -- control how the `@Payload()` data is serialized and deserialized
