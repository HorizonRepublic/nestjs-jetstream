import { JetstreamError } from '../errors/jetstream-error';
import type { ScheduleErrorReason } from './schedule.types';

/** A schedule the client or the NATS server refused. */
export class JetstreamScheduleError extends JetstreamError<ScheduleErrorReason> {
  public constructor(reason: ScheduleErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamScheduleError';
  }
}
