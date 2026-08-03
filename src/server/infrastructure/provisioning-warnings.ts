import { Logger } from '@nestjs/common';

import { ManagementMode } from '../../interfaces';
import type { JetstreamModuleOptions } from '../../interfaces';

export const DESTRUCTIVE_MIGRATION_MANUAL_WARNING =
  'allowDestructiveMigration has no effect under provisioning.management: Manual; the library never migrates externally managed streams.';

export const warnIfManualWithDestructive = (
  options: JetstreamModuleOptions,
  logger: Logger,
): void => {
  if (
    options.allowDestructiveMigration &&
    options.provisioning?.management === ManagementMode.Manual
  ) {
    logger.warn(DESTRUCTIVE_MIGRATION_MANUAL_WARNING);
  }
};
