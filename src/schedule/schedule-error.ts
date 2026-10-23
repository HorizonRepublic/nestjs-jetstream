import type { ScheduleErrorReason } from './schedule.types';

/** A schedule the client or the NATS server refused. */
export class JetstreamScheduleError extends Error {
  public constructor(
    public readonly reason: ScheduleErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'JetstreamScheduleError';
  }
}
