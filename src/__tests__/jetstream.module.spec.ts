import { Logger, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { NatsConnection, Status, Subscription } from '@nats-io/transport-node';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JetstreamClient } from '../client';
import { JsonCodec } from '../codec';
import type { ConnectionProvider, ConnectionRegistry } from '../connection';
import type { ConnectionScope } from '../connection/connection.types';
import type { EventBus } from '../hooks';
import { ManagementMode } from '../interfaces';
import type { JetstreamModuleOptions, ResolvedConnectionOptions } from '../interfaces';
import {
  JETSTREAM_CONNECTIONS,
  JETSTREAM_EVENT_BUS,
  JETSTREAM_OPTIONS,
} from '../jetstream.constants';
import {
  DESTRUCTIVE_MIGRATION_MANUAL_WARNING,
  JetstreamModule,
  warnIfManualWithDestructive,
} from '../jetstream.module';
import { NameResolver } from '../server/infrastructure/name-resolver';

type ModuleFactoryProvider = Extract<Provider, { provide: unknown; useFactory: unknown }>;

const baseOptions = (): JetstreamModuleOptions => ({
  name: 'svc',
  servers: ['nats://localhost:4222'],
});

describe('warnIfManualWithDestructive', () => {
  afterEach(vi.resetAllMocks);

  it('should warn when allowDestructiveMigration is true and management is Manual', () => {
    // Given
    const logger = createMock<Logger>();
    const options: JetstreamModuleOptions = {
      ...baseOptions(),
      provisioning: { management: ManagementMode.Manual, allowDestructiveMigration: true },
    };

    // When
    warnIfManualWithDestructive(options, logger);

    // Then
    expect(logger.warn).toHaveBeenCalledWith(DESTRUCTIVE_MIGRATION_MANUAL_WARNING);
  });

  it('should NOT warn when allowDestructiveMigration is true and management is Auto', () => {
    // Given
    const logger = createMock<Logger>();
    const options: JetstreamModuleOptions = {
      ...baseOptions(),
      provisioning: { management: ManagementMode.Auto, allowDestructiveMigration: true },
    };

    // When
    warnIfManualWithDestructive(options, logger);

    // Then
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should NOT warn when allowDestructiveMigration is true and only a per-kind override is Manual', () => {
    // Given: global provisioning.management is unset; only events.management.stream is Manual
    const logger = createMock<Logger>();
    const options: JetstreamModuleOptions = {
      ...baseOptions(),
      provisioning: { allowDestructiveMigration: true },
      events: { management: { stream: ManagementMode.Manual } },
    };

    // When
    warnIfManualWithDestructive(options, logger);

    // Then: warn fires only on the global provisioning.management flag, not per-kind overrides
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('connection scope wiring', () => {
  afterEach(vi.resetAllMocks);

  it('should invoke warnIfManualWithDestructive while building a connection scope', async () => {
    // Given a Manual-managed service that also asks for destructive migration
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const options: JetstreamModuleOptions = {
      ...baseOptions(),
      provisioning: { management: ManagementMode.Manual, allowDestructiveMigration: true },
    };

    const { providers = [] } = JetstreamModule.forRoot(options);
    const scopeProviders = (providers as Provider[]).filter(
      (p): p is ModuleFactoryProvider =>
        'provide' in p &&
        (p.provide === JETSTREAM_CONNECTIONS || p.provide === JETSTREAM_EVENT_BUS),
    );

    expect(scopeProviders).toHaveLength(2);

    // When: compile a minimal module so the registry factory actually runs
    await Test.createTestingModule({
      providers: [{ provide: JETSTREAM_OPTIONS, useValue: options }, ...scopeProviders],
    }).compile();

    // Then: the factory ran and issued the warn through a real Logger instance
    expect(warnSpy).toHaveBeenCalledWith(DESTRUCTIVE_MIGRATION_MANUAL_WARNING);
  });
});

describe('forFeature client wiring', () => {
  afterEach(vi.resetAllMocks);

  const featureFactory = (connectionName: string): ModuleFactoryProvider['useFactory'] => {
    const { providers = [] } = JetstreamModule.forFeature({
      name: faker.word.noun(),
      connection: connectionName,
    });
    const [provider] = providers as ModuleFactoryProvider[];

    return provider!.useFactory;
  };

  it('should build the client from the per-connection rpc mode, not the root one', async () => {
    // Given a named connection that switches to JetStream RPC over the Core-mode default
    const connectionName = faker.word.noun();
    const resolved: ResolvedConnectionOptions = {
      name: faker.word.noun(),
      servers: ['nats://localhost:4222'],
      connectionName,
      critical: true,
      rpc: { mode: 'jetstream' },
    };
    const nc = createMock<NatsConnection>({
      subscribe: vi.fn().mockReturnValue(createMock<Subscription>()),
    });
    const connection = createMock<ConnectionProvider>({
      getConnection: vi.fn().mockResolvedValue(nc),
      status$: new Subject<Status>().asObservable(),
    });
    const scope = createMock<ConnectionScope>({
      options: resolved,
      connection,
      codec: new JsonCodec(),
      names: new NameResolver(resolved),
    });
    const registry = createMock<ConnectionRegistry>({ get: vi.fn().mockReturnValue(scope) });

    // When the feature client is created and connected
    const sut = featureFactory(connectionName)(registry, createMock<EventBus>()) as JetstreamClient;

    await sut.connect();

    // Then it opens the JetStream RPC reply inbox, which Core mode never does
    expect(sut).toBeInstanceOf(JetstreamClient);
    expect(nc.subscribe).toHaveBeenCalledTimes(1);

    await sut.close();
  });
});
