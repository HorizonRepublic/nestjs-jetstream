/** Health status returned by the JetStream health indicator. */
export interface JetstreamHealthStatus {
  /** Whether the NATS connection is alive. */
  connected: boolean;
  /** NATS server URL, or `null` if not connected. */
  server: string | null;
  /** Round-trip latency in ms, or `null` if disconnected. */
  latency: number | null;
}
