import type { ConfigErrorReason } from './errors.types';
import { JetstreamBaseError } from './jetstream-error';

/** The module configuration or a handler declaration is invalid. */
export class JetstreamConfigError extends JetstreamBaseError<ConfigErrorReason> {
  public constructor(reason: ConfigErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamConfigError';
  }
}
