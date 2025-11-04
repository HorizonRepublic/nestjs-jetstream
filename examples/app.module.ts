import { Module } from '@nestjs/common';
import { JetstreamClientModule, JetstreamServerModule } from '@horizon-republic/nestjs-jetstream';
import { AppMicroserviceController } from './app.microservice-controller';
import { AppController } from './app.controller';

@Module({
  imports: [
    JetstreamServerModule.forRoot({
      name: 'my_service', // Unique name for the JetStream service. Will be registered as `my_service__microservice``
      servers: ['localhost:4222'], // List of NATS servers to connect to.
    }),

    JetstreamClientModule.forFeature({
      name: 'my_service', // Should match the name of the JetStream service.
      servers: ['localhost:4222'],
    }),
  ],
  controllers: [AppMicroserviceController, AppController],
})
export class AppModule {}
