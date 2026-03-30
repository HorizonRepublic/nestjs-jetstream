<div align="center">

# @horizon-republic/nestjs-jetstream

**Ship reliable microservices with NATS JetStream and NestJS.**
Events, broadcast, ordered delivery, and RPC — with two lines of config.

[![npm version](https://img.shields.io/npm/v/@horizon-republic/nestjs-jetstream.svg)](https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream)
[![codecov](https://codecov.io/github/HorizonRepublic/nestjs-jetstream/graph/badge.svg?token=40IPSWFMT4)](https://codecov.io/github/HorizonRepublic/nestjs-jetstream)
[![CI](https://github.com/HorizonRepublic/nestjs-jetstream/actions/workflows/coverage.yml/badge.svg)](https://github.com/HorizonRepublic/nestjs-jetstream/actions)
[![Documentation](https://img.shields.io/badge/docs-online-brightgreen.svg)](https://horizonrepublic.github.io/nestjs-jetstream/)

[![Node.js](https://img.shields.io/node/v/@horizon-republic/nestjs-jetstream.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

## Why this library?

NestJS ships with a NATS transport, but it's fire-and-forget. Messages vanish if no one's listening. This library adds JetStream — so your messages **survive restarts**, **retry on failure**, and **replay for new consumers**.

You keep writing `@EventPattern()` and `@MessagePattern()`. The library handles streams, consumers, and subjects automatically.

## What's inside

**Delivery modes** — workqueue (one consumer), broadcast (all consumers), ordered (sequential), and dual-mode RPC (Core or JetStream-backed).

**Production-ready** — dead letter queue, health checks, graceful shutdown with drain, lifecycle hooks for observability.

**Flexible** — pluggable codecs (JSON/MsgPack/Protobuf), per-stream configuration, publisher-only mode for API gateways.

## Quick Start

```bash
npm install @horizon-republic/nestjs-jetstream
```

```typescript
// app.module.ts
@Module({
  imports: [
    JetstreamModule.forRoot({ name: 'orders', servers: ['nats://localhost:4222'] }),
    JetstreamModule.forFeature({ name: 'orders' }),
  ],
})
export class AppModule {}

// orders.controller.ts
@Controller()
export class OrdersController {
  constructor(@Inject('orders') private client: ClientProxy) {}

  @EventPattern('order.created')
  handle(@Payload() data: { orderId: number }) {
    console.log('Order created:', data.orderId);
  }

  @Get('emit')
  emit() {
    return this.client.emit('order.created', { orderId: 42 });
  }
}
```

## Documentation

**[Read the full documentation →](https://horizonrepublic.github.io/nestjs-jetstream/)**

| Section | What you'll learn |
|---------|-------------------|
| [Getting Started](https://horizonrepublic.github.io/nestjs-jetstream/docs/getting-started/installation) | Installation, module setup, first handler |
| [Messaging Patterns](https://horizonrepublic.github.io/nestjs-jetstream/docs/patterns/rpc) | RPC, Events, Broadcast, Ordered Events |
| [Guides](https://horizonrepublic.github.io/nestjs-jetstream/docs/guides/record-builder) | Handler context, DLQ, health checks, performance tuning |
| [Migration](https://horizonrepublic.github.io/nestjs-jetstream/docs/guides/migration) | From built-in NATS transport or between versions |
| [API Reference](https://horizonrepublic.github.io/nestjs-jetstream/docs/reference/api/) | Full TypeDoc-generated API |

## Links

- [npm](https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream)
- [GitHub](https://github.com/HorizonRepublic/nestjs-jetstream)
- [Documentation](https://horizonrepublic.github.io/nestjs-jetstream/)
- [Issues](https://github.com/HorizonRepublic/nestjs-jetstream/issues)
- [Discussions](https://github.com/HorizonRepublic/nestjs-jetstream/discussions)

## License

MIT
