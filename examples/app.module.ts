import { Module } from '@nestjs/common';

import { JetstreamModule, TransportEvent } from '../src';

import { AppController } from './app.controller';
import { AppMicroserviceController } from './app.microservice-controller';

@Module({
  imports: [
    // Global setup — creates shared NATS connection, codec, event bus,
    // and consumer infrastructure (streams, consumers, routers).
    JetstreamModule.forRoot({
      name: 'my-service',
      servers: ['localhost:4222'],

      // RPC mode: 'core' (default) uses NATS request/reply,
      // 'jetstream' persists commands in a stream.
      rpc: { mode: 'core', timeout: 10_000 },
      events: { stream: { storage: 'memory' } },

      // Optional lifecycle hooks (falls back to NestJS Logger)
      hooks: {
        [TransportEvent.Connect]: (server) => {
          console.log(`Connected to ${server}`);
        },
        [TransportEvent.Error]: (err, source) => {
          console.error(`[${source}]`, err);
        },
      },
    }),

    // Feature client — lightweight proxy targeting a specific service.
    // Reuses the shared NATS connection from forRoot().
    JetstreamModule.forFeature({ name: 'my-service' }),
  ],
  controllers: [AppMicroserviceController, AppController],
})
export class AppModule {}
