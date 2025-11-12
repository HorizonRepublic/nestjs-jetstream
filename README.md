# NestJS JetStream Transport

A NestJS transport layer for NATS JetStream, providing native support for both Event-driven (fire-and-forget) and Command (RPC) communication patterns.

[![npm version](https://img.shields.io/npm/v/@horizon-republic/nestjs-jetstream.svg)](https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream)
[![codecov](https://codecov.io/github/HorizonRepublic/nestjs-jetstream/graph/badge.svg?token=40IPSWFMT4)](https://codecov.io/github/HorizonRepublic/nestjs-jetstream)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview

`@horizon-republic/nestjs-jetstream` is a modern, type-safe, and high-performance transport for integrating NestJS microservices with NATS JetStream.

It is designed to support persistent events, hybrid RPC requests, and advanced delivery guarantees without sacrificing developer experience.
This transport bridges the gap between NestJS simplicity and JetStream reliability.

## Key Features

- Full JetStream integration – persistent message delivery with fine-grained acknowledgment control.
- Dual messaging patterns – events (pub/sub) and commands (RPC) supported out of the box.
- Hybrid RPC mode – JetStream for guaranteed command delivery, Core NATS INBOX for fast replies.
- Pull-based consumers – predictable message flow and controlled concurrency.
- Multiple instances – easily register several microservices in the same application.

## Installation

```shell
npm install @horizon-republic/nestjs-jetstream
```

## Quick Start

### Server (Consumer)
Register the server module in your `app.module.ts`:

```typescript
import { JetstreamServerModule } from '@horizon-republic/nestjs-jetstream';

imports: [
  JetstreamServerModule.forRoot({
    name: 'my_service',
    servers: ['localhost:4222'],
  }),
];

```

Initialize the transport in `main.ts`:

```typescript
import { getJetStreamTransportToken, JetstreamTransport } from '@horizon-republic/nestjs-jetstream';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const transport: JetstreamTransport = app.get(getJetStreamTransportToken('my_service'));

  app.connectMicroservice(transport, { inheritAppConfig: true });
  await app.startAllMicroservices();
  await app.listen(3000);
}
```

Expected console output after a successful setup:
```shell
[StreamProvider] Stream created: my_service__microservice_ev-stream
[StreamProvider] Stream created: my_service__microservice_cmd-stream
[ConnectionProvider] NATS connection established: localhost:4222
[ConnectionProvider] JetStream manager initialized
```

### Message Handlers
Define handlers using the standard NestJS decorators:

```typescript
import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

@Controller()
export class AppMicroserviceController {
  @EventPattern('user.created')
  handleUserCreated(@Payload() payload: any) {
    console.log('Received event:', payload);
  }

  @MessagePattern('user.get')
  handleUserGet(@Payload() payload: any) {
    console.log('Received command:', payload);
    return { id: 1, name: 'John Doe' };
  }
}
```

### Client (Publisher)

Register the client module:
```typescript
import { JetstreamClientModule } from '@horizon-republic/nestjs-jetstream';

imports: [
  JetstreamClientModule.forFeature({
    name: 'my_service',
    servers: ['localhost:4222'],
  }),
];
```

Use the client in your service or controller:
```typescript
import { Controller, Get, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

@Controller()
export class AppController {
  constructor(
    @Inject('my_service')
    private readonly myServiceClient: ClientProxy,
  ) {}

  @Get('send-event')
  async sendEvent() {
    return this.myServiceClient.emit('user.created', { name: 'Alice' });
  }

  @Get('send-command')
  async sendCommand() {
    return this.myServiceClient.send('user.get', { id: 1 });
  }
}
```

## Roadmap

### Core (Stable)
- Integration with `Server` and `ClientProxy`
- Pull-based consumer support
- Hybrid RPC model (JetStream + Core INBOX)
- Context-based acknowledgment and message metadata
- Multi-service instance support

### Short Term
- Asynchronous registration (`forRootAsync` / `forFeatureAsync`)
- Dynamic configuration providers
- Healthcheck integration (NestJS Terminus)
- Prometheus/OpenTelemetry metrics (ack latency, queue depth, etc.)
- `NatsRequestBuilder` for fluent RPC request creation
- Extended examples and documentation

### Mid Term
- Preset stream configurations: work-queue, broadcast, durable, ephemeral
- Custom codecs (MessagePack, Avro, Protobuf)
- Extended context (advanced mode for raw `JsMsg` access)

### Long Term
- Cross-service tracing (W3C/B3 header propagation)

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

MIT

## Links

- [NATS JetStream Documentation](https://docs.nats.io/nats-concepts/jetstream)
- [NestJS Microservices](https://docs.nestjs.com/microservices/basics)
- [GitHub Repository](https://github.com/HorizonRepublic/nestjs-jetstream)
- [npm Package](https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream)

## Support

- 🐛 [Report bugs](https://github.com/HorizonRepublic/nestjs-jetstream/issues)
- 💬 [Discussions](https://github.com/HorizonRepublic/nestjs-jetstream/discussions)
- 📧 Email: [themaiby0@gmail.com](mailto:themaiby0@gmail.com)
