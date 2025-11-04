import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { getJetStreamTransportToken, JetstreamTransport } from '@horizon-republic/nestjs-jetstream';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule);

  const port = process.env.PORT ?? 3000;

  const logger = new Logger('bootstrap');

  // Get transport instance:
  // name should be the same as the one used in AppModule. Better to use a constant or environment variable.
  const transport: JetstreamTransport = app.get(getJetStreamTransportToken('my_service'));

  app.connectMicroservice(transport, { inheritAppConfig: true });

  await app.startAllMicroservices();
  // end of example

  await app.listen(port, () => {
    logger.log(`🚀 Application is running on: http://localhost:${port}`);
  });
};

void bootstrap();
