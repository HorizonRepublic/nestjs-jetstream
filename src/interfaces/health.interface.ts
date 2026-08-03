import type { JetstreamConnectionHealth } from './connection.interface';

/** Health status returned by the JetStream health indicator. */
export interface JetstreamHealthStatus {
  /** Whether every critical connection is alive. */
  connected: boolean;
  /** Default connection's NATS server URL, or `null` if not connected. */
  server: string | null;
  /** Default connection's round-trip latency in ms, or `null` if disconnected. */
  latency: number | null;
  /**
   * Whether at least one non-critical connection is down.
   *
   * Orthogonal to `connected`, and absent when only one connection is configured.
   */
  degraded?: boolean;
  /**
   * Per-connection breakdown.
   *
   * Absent when only one connection is configured, so the single-connection
   * response is byte-for-byte what it was before named connections existed.
   */
  connections?: Record<string, JetstreamConnectionHealth>;
}
