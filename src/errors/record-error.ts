import type { RecordErrorReason } from './errors.types';
import { JetstreamError } from './jetstream-error';

/** A record or its delivery options were rejected before publishing. */
export class JetstreamRecordError extends JetstreamError<RecordErrorReason> {
  public constructor(reason: RecordErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamRecordError';
  }
}
