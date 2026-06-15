import { INestApplication, Type } from '@nestjs/common';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { jetstreamManager, type JetStreamManager } from '@nats-io/jetstream';

import {
  JetstreamModule,
  JetstreamStrategy,
  StreamKind,
  streamName,
  dlqStreamName,
} from '../../src';
import type { JetstreamModuleOptions } from '../../src';

/** Unique service name per test to avoid stream/consumer collisions. */
export const uniqueServiceName = (): string => `test-${Math.random().toString(36).slice(2, 10)}`;

export const createNatsConnection = async (port: number): Promise<NatsConnection> =>
  connect({ servers: [`nats://localhost:${port}`] });

/** Bootstrap a NestJS app with the JetStream microservice strategy started. */
export const createTestApp = async (
  options: Partial<JetstreamModuleOptions> & { name: string; port: number },
  controllers: Type[] = [],
  clientTargets: string[] = [],
): Promise<{ app: INestApplication; module: TestingModule }> => {
  const { port, ...moduleOptions } = options;
  const featureImports = clientTargets.map((name) => JetstreamModule.forFeature({ name }));

  const module = await Test.createTestingModule({
    imports: [
      JetstreamModule.forRoot({
        ...moduleOptions,
        servers: [`nats://localhost:${port}`],
      }),
      ...featureImports,
    ],
    controllers,
  }).compile();

  const app = module.createNestApplication({ logger: false });
  const strategy: JetstreamStrategy | undefined = module.get(JetstreamStrategy, { strict: false });

  // Publisher-only mode (consumer: false) has no strategy; skip microservice setup
  if (strategy) {
    app.connectMicroservice<MicroserviceOptions>({ strategy } as MicroserviceOptions);
    await app.startAllMicroservices();
  }

  await app.init();

  return { app, module };
};

/** Delete a stream, suppressing only "stream not found"; other failures propagate. */
export const deleteStreamIfExists = async (jsm: JetStreamManager, name: string): Promise<void> => {
  try {
    await jsm.streams.delete(name);
  } catch (err: unknown) {
    const isStreamNotFound = err instanceof Error && err.message.includes('stream not found');

    if (!isStreamNotFound) throw err;
  }
};

/** Delete all streams a test service may have created, via the production naming helpers. */
export const cleanupStreams = async (nc: NatsConnection, serviceName: string): Promise<void> => {
  const jsm = await jetstreamManager(nc);

  for (const kind of [StreamKind.Event, StreamKind.Command, StreamKind.Ordered] as const) {
    await deleteStreamIfExists(jsm, streamName(serviceName, kind));
  }

  await deleteStreamIfExists(jsm, streamName(serviceName, StreamKind.Broadcast));
  await deleteStreamIfExists(jsm, dlqStreamName(serviceName));
};

export const waitForCondition = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> => {
  const start = Date.now();

  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
};
