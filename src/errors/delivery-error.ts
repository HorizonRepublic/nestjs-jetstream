import type { DeliveryErrorReason } from './errors.types';
import { JetstreamBaseError } from './jetstream-error';

/** A delivered event could not be handled; passed to `onDeadLetter` and the DLQ. */
export class JetstreamDeliveryError extends JetstreamBaseError<DeliveryErrorReason> {
  public constructor(reason: DeliveryErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamDeliveryError';
  }
}
