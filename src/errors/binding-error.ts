import type { BindingErrorReason } from './errors.types';
import { JetstreamBaseError } from './jetstream-error';

/** Externally managed streams or consumers do not fit the registered handlers. */
export class JetstreamBindingError extends JetstreamBaseError<BindingErrorReason> {
  public constructor(reason: BindingErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamBindingError';
  }
}
