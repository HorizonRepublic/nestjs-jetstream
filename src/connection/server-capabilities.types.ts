/** A server-side feature the transport gates on the JetStream API level. */
export enum NatsCapability {
  /** Per-message TTL: `allow_msg_ttl` and the `Nats-TTL` header. */
  MessageTtl = 'message-ttl',
  /** One-shot message schedules: `allow_msg_schedules` and `Nats-Schedule: @at`. */
  MessageSchedules = 'message-schedules',
  /** Cron and interval message schedules. */
  RecurringSchedules = 'recurring-schedules',
}

/** A capability something is about to use, and who uses it, for the error message. */
export interface CapabilityUsage {
  readonly capability: NatsCapability;
  readonly usage: string;
}

/** What a capability needs and how to name it in an error. */
export interface CapabilityRequirement {
  readonly apiLevel: number;
  readonly natsVersion: string;
}

/** Why a feature was refused by the connected server. */
export enum CapabilityErrorReason {
  ServerTooOld = 'server-too-old',
}
