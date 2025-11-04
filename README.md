# NestJs JetStream Transport

A NestJS transport for NATS JetStream with built-in support for **Events** (fire-and-forget) and **Commands** (RPC)
messaging patterns.

[![npm version](https://img.shields.io/npm/v/jetstream-transport.svg)](https://www.npmjs.com/package/jetstream-transport)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- 🔄 **Full JetStream support**: JetStream used for persistence + Core NATS for low-latency replies in RPC
- 🚀 **Dual messaging patterns**: Events (pub/sub) and Commands (RPC)
- 🎯 **Type-safe**: Full TypeScript support with strict types
- 📦 **Multiple instances**: Run multiple services in a single application
- ⚡ **High performance**: Optimized for throughput and low latency
- 🛡️ **Reliable**: At-least-once delivery with configurable acknowledgment strategies

# ToDo

- 🔧 **Configurable**: Extensive stream and consumer configuration options

## Installation

```bash
npm install @horizon-republic/nestjs-jetstream
```

# Quick Start

## Server (Consumer)

Register the module in your app.module.ts:

```typescript
import {JetstreamServerModule} from '@horizon-republic/nestjs-jetstream'

imports: [
    JetstreamServerModule.forRoot({
        name: 'my_service', // Unique name for the JetStream service. Will be registered as `my_service__microservice``
        servers: ['localhost:4222'], // List of NATS servers to connect to.
    }),
],
```

Get transport instance in your main.ts:

```typescript
import {getJetStreamTransportToken, JetstreamTransport} from '@horizon-republic/nestjs-jetstream';

const bootstrap = async () => {
    // ... your code here

    const transport: JetstreamTransport = app.get(getJetStreamTransportToken('my_service'));

    app.connectMicroservice(transport, {inheritAppConfig: true});

    await app.startAllMicroservices();

    // ... app.listen() and etc
};
```

If everything is set up correctly, you should see the following logs in your console:

```shell
[Nest] 98936  - 11/04/2025, 10:25:59 PM     LOG [StreamProvider] Ensure stream requested: my_service__microservice_ev-stream
[Nest] 98936  - 11/04/2025, 10:25:59 PM     LOG [StreamProvider] Ensure stream requested: my_service__microservice_cmd-stream
[Nest] 98936  - 11/04/2025, 10:25:59 PM     LOG [ConnectionProvider] NATS connection established: localhost:4222
[Nest] 98936  - 11/04/2025, 10:25:59 PM     LOG [ConnectionProvider] NATS JetStream manager initialized
[Nest] 98936  - 11/04/2025, 10:25:59 PM   DEBUG [StreamProvider] Checking stream existence: my_service__microservice_ev-stream
[Nest] 98936  - 11/04/2025, 10:25:59 PM   DEBUG [StreamProvider] Checking stream existence: my_service__microservice_cmd-stream
[Nest] 98936  - 11/04/2025, 10:25:59 PM     LOG [StreamProvider] Stream exists, updating: my_service__microservice_ev-stream (subjects: 1)
[Nest] 98936  - 11/04/2025, 10:25:59 PM     LOG [StreamProvider] Stream exists, updating: my_service__microservice_cmd-stream (subjects: 1)
[Nest] 98936  - 11/04/2025, 10:25:59 PM   DEBUG [ConsumerProvider] Consumer exists: my_service__microservice_cmd-consumer
[Nest] 98936  - 11/04/2025, 10:25:59 PM   DEBUG [ConsumerProvider] Consumer exists: my_service__microservice_ev-consumer
```

Consumer register 2 message handlers and process them independently:

- `my_service__microservice_ev-stream` - for events
- `my_service__microservice_cmd-stream` - for commands

**Message Handlers:**

You can register message handlers for events and commands in the same way as you would do for any other NestJS
microservice.
You can use the `@EventPattern` and `@MessagePattern` decorators not only in controllers, but also in other classes as
well.

```typescript
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { Controller } from '@nestjs/common';

@Controller()
export class AppMicroserviceController {
    @EventPattern('user.created')
    public handleEvent(@Payload() payload: any) {
        console.log('Received event:', payload);
    }

    @MessagePattern('user.get')
    public handleCommand(@Payload() payload: any) {
        console.log('Received command:', payload);

        return {
            id: 1,
            name: 'John Doe',
        };
    }
}

```

## Client (Publisher)

Register the module in your module:

```typescript
import { JetstreamClientModule } from '@horizon-republic/nestjs-jetstream';

imports: [
    JetstreamClientModule.forFeature({
        name: 'my_service', // Should match the name of the server module because routing is based on the name
        servers: ['localhost:4222'],
    }),
]
```

**Using the Client:**

```typescript
import { ClientProxy } from '@nestjs/microservices';
import { Controller, Get, Inject } from '@nestjs/common';

@Controller()
export class AppMicroserviceController {
    public constructor(
        @Inject('my_service')
        private readonly myServiceProxy: ClientProxy,
    ) {}

    @Get('send-event')
    public sendEvent() {
        return this.myServiceProxy.emit('user.created', { someData: 'someData' });
    }

    @Get('send-command')
    public sendCommand() {
        return this.myServiceProxy.send('user.get', { id: 1 });
    }
}

```

Success connection will trigger the following log:

```shell
[Nest] 843  - 11/04/2025, 10:37:37 PM     LOG [JetstreamClientProxy] Inbox subscription established: my_service__microservice.PWL9AF1Y7EQKTZ8RSA0V0Y
```

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

MIT © [Your Name]

## Links

- [NATS JetStream Documentation](https://docs.nats.io/nats-concepts/jetstream)
- [NestJS Microservices](https://docs.nestjs.com/microservices/basics)
- [GitHub Repository](https://github.com/HorizonRepublic/nestjs-jetstream)
- [npm Package](https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream)

## Support

- 🐛 [Report bugs](https://github.com/HorizonRepublic/nestjs-jetstream/issues)
- 💬 [Discussions](https://github.com/HorizonRepublic/nestjs-jetstream/discussions)
- 📧 Email: [themaiby0@gmail.com](mailto:themaiby0@gmail.com)