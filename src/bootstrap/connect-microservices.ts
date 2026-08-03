import type { INestApplication } from '@nestjs/common';
import type { MicroserviceOptions } from '@nestjs/microservices';

import type { ConnectionRegistry } from '../connection/connection-registry';
import { JETSTREAM_CONNECTIONS } from '../jetstream.constants';
import type { JetstreamBootstrapOptions } from './bootstrap.types';

/**
 * Attach one NestJS microservice per configured connection.
 *
 * Publisher-only connections have no strategy and are skipped. Call
 * `await app.startAllMicroservices()` afterwards, as with any hybrid app.
 *
 * @param app The hybrid Nest application.
 * @param options Hybrid options forwarded to every microservice.
 *
 * @example
 * ```typescript
 * const app = await NestFactory.create(AppModule);
 *
 * connectJetstreamMicroservices(app);
 * await app.startAllMicroservices();
 * await app.listen(3000);
 * ```
 */
export const connectJetstreamMicroservices = (
  app: INestApplication,
  options?: JetstreamBootstrapOptions | undefined,
): void => {
  const registry = app.get<ConnectionRegistry>(JETSTREAM_CONNECTIONS, { strict: false });

  for (const scope of registry.all()) {
    if (!scope.strategy) continue;

    app.connectMicroservice<MicroserviceOptions>(
      { strategy: scope.strategy } as MicroserviceOptions,
      options?.hybridOptions,
    );
  }
};
