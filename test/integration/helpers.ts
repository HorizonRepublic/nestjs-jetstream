import { INestApplication, Type } from '@nestjs/common';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import { connect, NatsConnection } from 'nats';

import { JetstreamModule, JetstreamStrategy } from '../../src';
import type { JetstreamModuleOptions } from '../../src/interfaces';
import { streamName } from '../../src/jetstream.constants';

/**
 * Create a unique service name per test to avoid stream/consumer collisions.
 */
export const uniqueServiceName = (): string => `test-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Create a standalone NATS connection for test assertions.
 */
export const createNatsConnection = async (port: number): Promise<NatsConnection> =>
  connect({ servers: [`nats://localhost:${port}`] });

/**
 * Bootstrap a full NestJS app with JetStream microservice transport.
 * Returns the app (with strategy started) and the compiled module.
 *
 * @param options Module options (name and port are required).
 * @param controllers Controllers to register with the module.
 * @param clientTargets Service names to register as forFeature clients.
 */
export const createTestApp = async (
  options: Partial<JetstreamModuleOptions> & { name: string; port: number },
  controllers: Type[] = [],
  clientTargets: string[] = [],
): Promise<{ app: INestApplication; module: TestingModule }> => {
  const { port, servers: _servers, ...moduleOptions } = options;
  const featureImports = clientTargets.map((name) => JetstreamModule.forFeature({ name }));

  const module = await Test.createTestingModule({
    imports: [
      JetstreamModule.forRoot({
        servers: [`nats://localhost:${port}`],
        ...moduleOptions,
      }),
      ...featureImports,
    ],
    controllers,
  }).compile();

  const app = module.createNestApplication({ logger: false });
  const strategy: JetstreamStrategy | undefined = module.get(JetstreamStrategy, { strict: false });

  // Publisher-only mode (consumer: false) has no strategy — skip microservice setup
  if (strategy) {
    app.connectMicroservice<MicroserviceOptions>({ strategy } as MicroserviceOptions);
    await app.startAllMicroservices();
  }

  await app.init();

  return { app, module };
};

/**
 * Silently delete a stream if it exists. Only suppresses "stream not found"
 * errors — auth/connection failures will propagate.
 */
const deleteStreamIfExists = async (
  jsm: Awaited<ReturnType<NatsConnection['jetstreamManager']>>,
  name: string,
): Promise<void> => {
  try {
    await jsm.streams.delete(name);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';

    if (!msg.includes('stream not found')) throw err;
  }
};

/**
 * Clean up streams and consumers created during test.
 * Uses the same naming helpers as production code to stay in sync.
 */
export const cleanupStreams = async (nc: NatsConnection, serviceName: string): Promise<void> => {
  const jsm = await nc.jetstreamManager();

  for (const kind of ['ev', 'cmd', 'ordered'] as const) {
    await deleteStreamIfExists(jsm, streamName(serviceName, kind));
  }

  await deleteStreamIfExists(jsm, streamName(serviceName, 'broadcast'));
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
