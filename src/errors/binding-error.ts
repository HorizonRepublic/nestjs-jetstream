import type { BindingErrorReason } from './errors.types';
import { JetstreamError } from './jetstream-error';

/** Externally managed streams or consumers do not fit the registered handlers. */
export class JetstreamBindingError extends JetstreamError<BindingErrorReason> {
  public constructor(reason: BindingErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamBindingError';
  }
}
