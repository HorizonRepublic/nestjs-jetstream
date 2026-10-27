import type { DeliveryErrorReason } from './errors.types';
import { JetstreamError } from './jetstream-error';

/** A delivered event could not be handled; passed to `onDeadLetter` and the DLQ. */
export class JetstreamDeliveryError extends JetstreamError<DeliveryErrorReason> {
  public constructor(reason: DeliveryErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamDeliveryError';
  }
}
