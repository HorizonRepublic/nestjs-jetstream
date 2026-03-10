/** Options for transport-controlled headers on outbound messages. */
export interface TransportHeaderOptions {
  messageId: string;
  subject: string;
  correlationId?: string;
  replyTo?: string;
}

/** Normalized envelope extracted from raw payload or JetstreamRecord. */
export interface ExtractedRecordData {
  data: unknown;
  hdrs: Map<string, string> | null;
  timeout: number | undefined;
}
