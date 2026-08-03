import { Controller, Injectable, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EventPattern, MicroserviceOptions, Payload } from '@nestjs/microservices';
import type { ClientProxy } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';

import type { NatsConnection } from '@nats-io/transport-node';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  connectJetstreamMicroservices,
  getClientToken,
  JetstreamHealthIndicator,
  JetstreamModule,
  JetstreamStrategy,
} from '../../src';
import type { JetstreamModuleOptions } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

const received: string[] = [];

@Controller()
class AsyncController {
  @EventPattern('async.event')
  public onEvent(@Payload() data: { id: string }): void {
    received.push(data.id);
  }
}

/** Stands in for a ConfigService: the shape `useExisting` and `useClass` resolve. */
@Injectable()
class JetstreamConfig {
  public servers: string[] = [];

  public constructor() {
    this.servers = [process.env.TEST_NATS_URL ?? 'nats://localhost:4222'];
  }
}

@Module({ providers: [JetstreamConfig], exports: [JetstreamConfig] })
class ConfigTestModule {}

/**
 * `forRootAsync` shares its provider set with `forRoot`, so the connection
 * registry rewrite has to hold for all three async shapes as well.
 */
describe('forRootAsync', () => {
  let container: StartedTestContainer;
  let nc: NatsConnection;
  let port: number;
  let app: INestApplication | undefined;
  let serviceName: string;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);
    process.env.TEST_NATS_URL = `nats://localhost:${port}`;
  });

  afterAll(async () => {
    delete process.env.TEST_NATS_URL;

    try {
      await nc.drain();
    } finally {
      await container.stop();
    }
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    received.length = 0;
    await cleanupStreams(nc, serviceName);
  });

  /** Boot an app from a ready-made dynamic module, the v2 single-strategy way. */
  const boot = async (
    rootModule: ReturnType<typeof JetstreamModule.forRootAsync>,
  ): Promise<INestApplication> => {
    const module = await Test.createTestingModule({
      imports: [rootModule, JetstreamModule.forFeature({ name: serviceName })],
      controllers: [AsyncController],
    }).compile();

    const created = module.createNestApplication({ logger: false });
    const strategy = module.get<JetstreamStrategy | null>(JetstreamStrategy, { strict: false });

    // Publisher-only configurations resolve a null strategy; none here do, but
    // the guard keeps this helper usable if one is added later.
    if (strategy !== null) {
      created.connectMicroservice<MicroserviceOptions>({ strategy } as MicroserviceOptions);
      await created.startAllMicroservices();
    }

    await created.init();

    return created;
  };

  it('should boot through useFactory and deliver events', async () => {
    // Given an async factory returning a flat configuration
    serviceName = uniqueServiceName();

    app = await boot(
      JetstreamModule.forRootAsync({
        name: serviceName,
        useFactory: (): Omit<JetstreamModuleOptions, 'name'> => ({
          servers: [`nats://localhost:${port}`],
        }),
      }),
    );

    // When an event is published
    app.get<ClientProxy>(getClientToken(serviceName)).emit('async.event', { id: 'factory' });

    // Then the handler receives it
    await waitForCondition(() => received.includes('factory'), 15_000);
    expect(received).toContain('factory');
  });

  it('should boot through useFactory with injected dependencies', async () => {
    // Given a factory that depends on an imported provider
    serviceName = uniqueServiceName();

    app = await boot(
      JetstreamModule.forRootAsync({
        name: serviceName,
        imports: [ConfigTestModule],
        inject: [JetstreamConfig],
        useFactory: (config: unknown): Omit<JetstreamModuleOptions, 'name'> => ({
          servers: (config as JetstreamConfig).servers,
        }),
      }),
    );

    // When an event is published
    app.get<ClientProxy>(getClientToken(serviceName)).emit('async.event', { id: 'injected' });

    // Then the injected configuration was actually used
    await waitForCondition(() => received.includes('injected'), 15_000);
    expect(received).toContain('injected');
  });

  it('should boot through useExisting', async () => {
    // Given an existing provider carrying the configuration
    serviceName = uniqueServiceName();

    app = await boot(
      JetstreamModule.forRootAsync({
        name: serviceName,
        imports: [ConfigTestModule],
        useExisting: JetstreamConfig,
      }),
    );

    // When an event is published
    app.get<ClientProxy>(getClientToken(serviceName)).emit('async.event', { id: 'existing' });

    // Then it is delivered
    await waitForCondition(() => received.includes('existing'), 15_000);
    expect(received).toContain('existing');
  });

  it('should boot through useClass', async () => {
    // Given a configuration class instantiated by the module
    serviceName = uniqueServiceName();

    app = await boot(
      JetstreamModule.forRootAsync({
        name: serviceName,
        useClass: JetstreamConfig,
      }),
    );

    // When an event is published
    app.get<ClientProxy>(getClientToken(serviceName)).emit('async.event', { id: 'class' });

    // Then it is delivered
    await waitForCondition(() => received.includes('class'), 15_000);
    expect(received).toContain('class');
  });

  it('should keep the single-connection health shape under forRootAsync', async () => {
    // Given an async-configured single-connection app
    serviceName = uniqueServiceName();

    app = await boot(
      JetstreamModule.forRootAsync({
        name: serviceName,
        useFactory: (): Omit<JetstreamModuleOptions, 'name'> => ({
          servers: [`nats://localhost:${port}`],
        }),
      }),
    );

    // When health is checked
    const status = await app.get(JetstreamHealthIndicator).check();

    // Then the async path reports the same shape as the sync one
    expect(Object.keys(status).toSorted()).toEqual(['connected', 'latency', 'server']);
    expect(status.connected).toBe(true);
  });

  it('should support named connections declared asynchronously', async () => {
    // Given an async factory returning the multi-connection form
    serviceName = uniqueServiceName();

    const module = await Test.createTestingModule({
      imports: [
        JetstreamModule.forRootAsync({
          name: serviceName,
          useFactory: (): Omit<JetstreamModuleOptions, 'name'> => ({
            defaultConnection: 'primary',
            connections: { primary: { servers: [`nats://localhost:${port}`] } },
          }),
        }),
        JetstreamModule.forFeature({ name: serviceName, connection: 'primary' }),
      ],
      controllers: [AsyncController],
    }).compile();

    app = module.createNestApplication({ logger: false });

    connectJetstreamMicroservices(app);
    await app.startAllMicroservices();
    await app.init();

    // When an event is published through the named connection
    app
      .get<ClientProxy>(getClientToken(serviceName, 'primary'))
      .emit('async.event', { id: 'async-named' });

    // Then it is delivered
    await waitForCondition(() => received.includes('async-named'), 15_000);
    expect(received).toContain('async-named');
  });
});
