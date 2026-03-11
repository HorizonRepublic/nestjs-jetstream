import { INestApplication, Type } from '@nestjs/common';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import { connect, NatsConnection } from 'nats';

import { JetstreamModule, JetstreamStrategy } from '../../src';
import type { JetstreamModuleOptions } from '../../src/interfaces';

const NATS_URL = 'nats://localhost:4222';

/**
 * Create a unique service name per test to avoid stream/consumer collisions.
 */
export const uniqueServiceName = (): string =>
  `test-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Create a standalone NATS connection for test assertions.
 */
export const createNatsConnection = async (): Promise<NatsConnection> =>
  connect({ servers: [NATS_URL] });

/**
 * Bootstrap a full NestJS app with JetStream microservice transport.
 * Returns the app (with strategy started) and the compiled module.
 *
 * @param options Module options (name is required).
 * @param controllers Controllers to register with the module.
 * @param clientTargets Service names to register as forFeature clients.
 */
export const createTestApp = async (
  options: Partial<JetstreamModuleOptions> & { name: string },
  controllers: Type[] = [],
  clientTargets: string[] = [],
): Promise<{ app: INestApplication; module: TestingModule }> => {
  const featureImports = clientTargets.map((name) =>
    JetstreamModule.forFeature({ name }),
  );

  const module = await Test.createTestingModule({
    imports: [
      JetstreamModule.forRoot({
        servers: [NATS_URL],
        ...options,
      }),
      ...featureImports,
    ],
    controllers,
  }).compile();

  const app = module.createNestApplication();
  const strategy = module.get(JetstreamStrategy);

  app.connectMicroservice<MicroserviceOptions>({ strategy } as MicroserviceOptions);
  await app.startAllMicroservices();
  await app.init();

  return { app, module };
};

/**
 * Clean up streams and consumers created during test.
 */
export const cleanupStreams = async (
  nc: NatsConnection,
  serviceName: string,
): Promise<void> => {
  const jsm = await nc.jetstreamManager();
  const internalName = `${serviceName}__microservice`;

  for (const suffix of ['ev-stream', 'cmd-stream']) {
    try {
      await jsm.streams.delete(`${internalName}_${suffix}`);
    } catch {
      /* stream may not exist */
    }
  }

  try {
    await jsm.streams.delete('broadcast-stream');
  } catch {
    /* stream may not exist */
  }
};

/**
 * Wait for an async condition to become true, polling at intervals.
 */
export const waitForCondition = async (
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> => {
  const start = Date.now();

  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
};
