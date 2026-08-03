import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { connectJetstreamMicroservices } from '../../src';
import { AppModule } from './app.module';

/**
 * A multi-connection application is a hybrid application: one NestJS
 * microservice per connection. `connectJetstreamMicroservices` attaches them
 * all, so the shared `bootstrap()` helper — which knows about a single
 * strategy — is not used here.
 */
const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  connectJetstreamMicroservices(app, { hybridOptions: { inheritAppConfig: true } });
  await app.startAllMicroservices();

  app.enableShutdownHooks();

  await app.listen(3010);
  logger.log('http://localhost:3010');
};

void bootstrap();
