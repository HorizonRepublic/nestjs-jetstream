import { Logger, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManagementMode } from '../interfaces';
import type { JetstreamModuleOptions } from '../interfaces';
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
      allowDestructiveMigration: true,
      provisioning: { management: ManagementMode.Manual },
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
      allowDestructiveMigration: true,
      provisioning: { management: ManagementMode.Auto },
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
      allowDestructiveMigration: true,
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
      allowDestructiveMigration: true,
      provisioning: { management: ManagementMode.Manual },
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
