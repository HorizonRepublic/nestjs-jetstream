import type { ConfigErrorReason } from './errors.types';
import { JetstreamError } from './jetstream-error';

/** The module configuration or a handler declaration is invalid. */
export class JetstreamConfigError extends JetstreamError<ConfigErrorReason> {
  public constructor(reason: ConfigErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamConfigError';
  }
}
