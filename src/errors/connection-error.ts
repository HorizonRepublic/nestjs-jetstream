import type { ConnectionErrorReason } from './errors.types';
import { JetstreamError } from './jetstream-error';

/** The NATS connection is not available. */
export class JetstreamConnectionError extends JetstreamError<ConnectionErrorReason> {
  public constructor(reason: ConnectionErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamConnectionError';
  }
}
