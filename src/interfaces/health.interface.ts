import type { JetstreamConnectionHealth } from './connection.interface';

/**
 * Where one consume flow stands: `starting` has not been live since the
 * transport started it, `active` is consuming, `recovering` was live and is
 * restarting.
 */
export type JetstreamConsumerState = 'starting' | 'active' | 'recovering';

/** Health of one consume flow (events, commands, broadcasts, ordered events or schedules). */
export interface JetstreamConsumerHealth {
  /** False once the flow has not been live for the stall threshold (30 seconds). */
  healthy: boolean;
  state: JetstreamConsumerState;
  /** Durable consumer name; `null` for the ephemeral ordered consumer. */
  consumer: string | null;
  /** Consecutive failed attempts since the flow was last live. */
  failures: number;
  /** How long the flow has not been live, in ms; `null` while it is. */
  downForMs: number | null;
  /** Message of the latest failed attempt; `null` while live. */
  lastError: string | null;
}

/** Health status returned by the JetStream health indicator. */
export interface JetstreamHealthStatus {
  /** Whether every critical connection is alive. */
  connected: boolean;
  /** Default connection's NATS server URL, or `null` if not connected. */
  server: string | null;
  /** Default connection's round-trip latency in ms, or `null` if disconnected. */
  latency: number | null;
  /**
   * Whether every critical connection that consumes has started and keeps its
   * consumers live. Orthogonal to `connected`, and absent when no connection
   * consumes (publisher-only, or no microservice attached).
   */
  consuming?: boolean;
  /**
   * The default connection's consume flows, keyed by kind (`event`, `command`,
   * `broadcast`, `ordered`, `schedule`). Absent when it does not consume.
   */
  consumers?: Record<string, JetstreamConsumerHealth>;
  /**
   * Whether at least one non-critical connection is down or not consuming.
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

/**
 * Terminus-shaped result of `JetstreamHealthIndicator.isHealthy()`: the
 * indicator key mapped to its details (`status`, `server`, `latency`, and
 * `degraded` / `connections` when several connections are configured).
 */
export type JetstreamHealthIndicatorResult = Record<string, Record<string, unknown>>;
