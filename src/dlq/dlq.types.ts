/** Which kind of message a dead letter was, judged by the stream it came from. */
export enum DeadLetterOrigin {
  Event = 'event',
  Broadcast = 'broadcast',
  Schedule = 'schedule',
  /** The original stream is none this connection provisions, e.g. renamed since. */
  Unknown = 'unknown',
}

/** Why a matching dead letter was not handed back. */
export enum DlqRedriveSkipReason {
  /** Broadcasts are signals; replaying an old one can roll state back. */
  Broadcast = 'broadcast',
  /** A recurring schedule fires again on its own; a late tick would run out of turn. */
  ScheduleTick = 'schedule-tick',
  /** No consumer of this service would deliver the subject, so the message would sit unhandled. */
  NoConsumer = 'no-consumer',
  /** It already went back `maxRedrives` times and failed each time. */
  RedriveLimit = 'redrive-limit',
  /** Publishing it to its original subject failed; it stays in the DLQ. */
  PublishFailed = 'publish-failed',
}

/** Headers the message carried when it was published, without the DLQ's own; every value of a repeated header is kept. */
export type DeadLetterHeaders = Readonly<Record<string, readonly string[]>>;

/** One message in the dead-letter stream. */
export interface DeadLetterRecord {
  /** Sequence in the dead-letter stream; stable while the record stays there. */
  readonly seq: number;
  /** Subject the message was published to. */
  readonly subject: string;
  /** Stream the message was consumed from. */
  readonly stream: string;
  readonly origin: DeadLetterOrigin;
  /** Handler pattern the subject maps to under this service's naming, if it maps to one. */
  readonly pattern: string | undefined;
  /** Last error of the handler. */
  readonly reason: string;
  readonly failedAt: Date | undefined;
  /** Deliveries of the final attempt. */
  readonly deliveryCount: number;
  /** How many times the message has been redriven already. */
  readonly redriveCount: number;
  readonly headers: DeadLetterHeaders;
  /** Raw payload. */
  readonly data: Uint8Array;
  /** Payload decoded with the connection's codec; `undefined` when it does not decode. */
  readonly payload: unknown;
}

/** Selects dead letters. Every criterion given must match; none selects all. */
export interface DeadLetterFilter {
  /** Original subject; the NATS wildcards `*` and `>` are allowed. */
  readonly subject?: string;
  /** Pattern of the failed handler, exactly as declared. */
  readonly pattern?: string;
  /** A substring of the reason, or an expression it must match. */
  readonly reason?: string | RegExp;
  /** Failed at or after this moment. */
  readonly failedAfter?: Date;
  /** Failed at or before this moment. */
  readonly failedBefore?: Date;
  /** Lowest DLQ sequence, inclusive. */
  readonly fromSeq?: number;
  /** Highest DLQ sequence, inclusive. */
  readonly toSeq?: number;
}

/** Which dead-letter stream to work on, and how much of it. */
export interface DlqScopeOptions {
  /** Connection whose dead-letter stream to use. Default: the default connection. */
  readonly connection?: string;
  /** Stop after this many matching records, skipped ones included. */
  readonly limit?: number;
}

/** Options for {@link JetstreamDlq.inspect}. `limit` defaults to 100. */
export type DlqInspectOptions = DlqScopeOptions;

/** Options for {@link JetstreamDlq.redrive}. */
export interface DlqRedriveOptions extends DlqScopeOptions {
  /** Report what would go back without publishing or deleting anything. */
  readonly dryRun?: boolean;
  /** Skip records already redriven this many times. Default: 3. */
  readonly maxRedrives?: number;
  /** Publish at most this many messages per second. Default: no limit. */
  readonly perSecond?: number;
}

/** Options for {@link JetstreamDlq.purge}. */
export interface DlqPurgeOptions extends DlqScopeOptions {
  /** Report what would be deleted without deleting it. */
  readonly dryRun?: boolean;
}

/** A matching record that was not handed back. */
export interface DlqRedriveSkip {
  readonly seq: number;
  readonly subject: string;
  readonly reason: DlqRedriveSkipReason;
  /** The publish error, for `publish-failed`. */
  readonly error?: string;
}

/** What a redrive did. */
export interface DlqRedriveReport {
  readonly dryRun: boolean;
  /** Records the filter selected. */
  readonly matched: number;
  /** DLQ sequences published back (or that would be, on a dry run). */
  readonly redriven: readonly number[];
  readonly skipped: readonly DlqRedriveSkip[];
  /**
   * Published back, but still in the DLQ because deleting them failed. A later
   * redrive within the target stream's `duplicate_window` is deduplicated;
   * after it, the message is delivered again.
   */
  readonly notRemoved: readonly number[];
}

/** What a purge did. */
export interface DlqPurgeReport {
  readonly dryRun: boolean;
  /** DLQ sequences deleted (or that would be, on a dry run). */
  readonly purged: readonly number[];
}
