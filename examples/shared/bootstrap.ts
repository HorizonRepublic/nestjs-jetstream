import { Logger, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { JetstreamStrategy } from '../../src';

/**
 * Shared bootstrap utility for all examples.
 * Creates a NestJS app with JetStream microservice transport.
 */
export const bootstrap = async (moduleClass: Type, port = 3000): Promise<void> => {
  const app = await NestFactory.create(moduleClass);
  const logger = new Logger('Bootstrap');

  const strategy = app.get(JetstreamStrategy, { strict: false });

  if (strategy) {
    app.connectMicroservice({ strategy }, { inheritAppConfig: true });
    await app.startAllMicroservices();
  }

  await app.listen(port);
  logger.log(`http://localhost:${port}`);
};
