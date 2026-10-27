import type { ConnectionErrorReason } from './errors.types';
import { JetstreamBaseError } from './jetstream-error';

/** The NATS connection is not available. */
export class JetstreamConnectionError extends JetstreamBaseError<ConnectionErrorReason> {
  public constructor(reason: ConnectionErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamConnectionError';
  }
}
