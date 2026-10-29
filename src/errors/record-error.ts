import type { RecordErrorReason } from './errors.types';
import { JetstreamBaseError } from './jetstream-error';

/** A record or its delivery options were rejected before publishing. */
export class JetstreamRecordError extends JetstreamBaseError<RecordErrorReason> {
  public constructor(reason: RecordErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamRecordError';
  }
}
