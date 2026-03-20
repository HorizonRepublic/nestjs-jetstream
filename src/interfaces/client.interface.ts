/** @internal Options for transport-controlled headers on outbound messages. */
export interface TransportHeaderOptions {
  /** Original NATS subject the message is published to. */
  subject: string;
  /** Correlation ID for JetStream RPC request/response matching. */
  correlationId?: string;
  /** Inbox subject for JetStream RPC responses. */
  replyTo?: string;
}

/** @internal Normalized envelope extracted from raw payload or {@link JetstreamRecord}. */
export interface ExtractedRecordData {
  /** Decoded message payload. */
  data: unknown;
  /** Custom headers from {@link JetstreamRecordBuilder}, or `null` if none. */
  hdrs: Map<string, string> | null;
  /** Per-request RPC timeout override in ms, or `undefined` for default. */
  timeout: number | undefined;
  /** Custom message ID for JetStream deduplication, or `undefined` for auto-generated UUID. */
  messageId: string | undefined;
}
