import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { Logger, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ManagementMode } from '../interfaces';
import type { JetstreamModuleOptions } from '../interfaces';
import { JETSTREAM_OPTIONS } from '../jetstream.constants';
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

describe('NameResolver factory wiring', () => {
  afterEach(vi.resetAllMocks);

  it('should invoke warnIfManualWithDestructive via the NameResolver provider factory', async () => {
    // Given
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const options: JetstreamModuleOptions = {
      ...baseOptions(),
      allowDestructiveMigration: true,
      provisioning: { management: ManagementMode.Manual },
    };

    const { providers = [] } = JetstreamModule.forRoot(options);
    const nameResolverProvider = (providers as Provider[]).find(
      (p): p is ModuleFactoryProvider => 'provide' in p && p.provide === NameResolver,
    );

    // When: compile a minimal module with the options value and the real NameResolver factory
    await Test.createTestingModule({
      providers: [{ provide: JETSTREAM_OPTIONS, useValue: options }, nameResolverProvider!],
    }).compile();

    // Then: the factory ran and issued the warn through a real Logger instance
    expect(warnSpy).toHaveBeenCalledWith(DESTRUCTIVE_MIGRATION_MANUAL_WARNING);
  });
});
