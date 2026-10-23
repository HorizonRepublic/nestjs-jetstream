/** A server-side feature the transport gates on the JetStream API level. */
export enum NatsCapability {
  /** Cron and interval message schedules (`Nats-Schedule` beyond `@at`). */
  RecurringSchedules = 'recurring-schedules',
}

/** What a capability needs and how to name it in an error. */
export interface CapabilityRequirement {
  readonly apiLevel: number;
  readonly natsVersion: string;
}
