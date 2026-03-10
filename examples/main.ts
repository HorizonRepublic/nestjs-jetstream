import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { JetstreamStrategy } from '../src';

import { AppModule } from './app.module';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Register JetStream as a microservice transport.
  // The strategy is created by forRoot() and managed via DI.
  // When consumer is disabled (consumer: false), the strategy resolves to null.
  app.connectMicroservice({ strategy: app.get(JetstreamStrategy) }, { inheritAppConfig: true });
  await app.startAllMicroservices();

  const port = process.env.PORT ?? 3000;

  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}`);
};

void bootstrap();
