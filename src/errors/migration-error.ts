import type { MigrationErrorReason } from './errors.types';
import { JetstreamBaseError } from './jetstream-error';

/** A destructive stream migration was refused or did not finish. */
export class JetstreamMigrationError extends JetstreamBaseError<MigrationErrorReason> {
  public constructor(reason: MigrationErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamMigrationError';
  }
}
