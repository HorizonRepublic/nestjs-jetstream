# @horizon-republic/nestjs-jetstream

Ship reliable microservices with NATS JetStream and NestJS. Events, broadcast, ordered delivery, and RPC — with two lines of config.

[![npm version](https://img.shields.io/npm/v/@horizon-republic/nestjs-jetstream.svg)](https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream)
[![codecov](https://codecov.io/github/HorizonRepublic/nestjs-jetstream/graph/badge.svg?token=40IPSWFMT4)](https://codecov.io/github/HorizonRepublic/nestjs-jetstream)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Socket Badge](https://badge.socket.dev/npm/package/@horizon-republic/nestjs-jetstream)](https://socket.dev/npm/package/@horizon-republic/nestjs-jetstream)

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

- [Getting Started](https://horizonrepublic.github.io/nestjs-jetstream/docs/getting-started) — installation, module setup, first handler
- [Guides](https://horizonrepublic.github.io/nestjs-jetstream/docs/guides/health-checks) — health checks, graceful shutdown, lifecycle hooks
- [API Reference](https://horizonrepublic.github.io/nestjs-jetstream/docs/reference/api/) — full TypeDoc-generated API

## Links

- [npm](https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream)
- [GitHub](https://github.com/HorizonRepublic/nestjs-jetstream)
- [Documentation](https://horizonrepublic.github.io/nestjs-jetstream/)
- [Issues](https://github.com/HorizonRepublic/nestjs-jetstream/issues)
- [Discussions](https://github.com/HorizonRepublic/nestjs-jetstream/discussions)

## License

MIT
