import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { Logger } from '@nestjs/common';

import { ManagementMode } from '../interfaces';
import type { JetstreamModuleOptions } from '../interfaces';
import { warnIfManualWithDestructive } from '../jetstream.module';

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
    expect(logger.warn).toHaveBeenCalledWith(
      'allowDestructiveMigration has no effect under provisioning.management: Manual — the library never migrates externally managed streams.',
    );
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
});
