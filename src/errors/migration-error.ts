import type { MigrationErrorReason } from './errors.types';
import { JetstreamError } from './jetstream-error';

/** A destructive stream migration was refused or did not finish. */
export class JetstreamMigrationError extends JetstreamError<MigrationErrorReason> {
  public constructor(reason: MigrationErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamMigrationError';
  }
}
