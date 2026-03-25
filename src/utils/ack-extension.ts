/** Default ack extension interval fallback when ack_wait is unknown (ms). */
const DEFAULT_ACK_EXTENSION_INTERVAL = 5_000;

/** Minimum ack extension interval to prevent excessive msg.working() calls (ms). */
const MIN_ACK_EXTENSION_INTERVAL = 500;

/**
 * Resolve the ack extension interval from user config and NATS ack_wait.
 *
 * @param config  - `false`/`undefined` → disabled, `number` → explicit ms, `true` → auto from ack_wait.
 * @param ackWaitNanos - Consumer `ack_wait` in nanoseconds (for auto-calculation).
 * @returns Interval in ms, or `null` if disabled.
 */
export const resolveAckExtensionInterval = (
  config: boolean | number | undefined,
  ackWaitNanos: number | undefined,
): number | null => {
  if (config === false || config === undefined) return null;
  if (typeof config === 'number') return config;

  if (!ackWaitNanos) return DEFAULT_ACK_EXTENSION_INTERVAL;

  // IMPORTANT: ack_wait is in NANOSECONDS. Convert to ms, then halve for the extension interval.
  const interval = Math.floor(ackWaitNanos / 1_000_000 / 2);

  return Math.max(interval, MIN_ACK_EXTENSION_INTERVAL);
};

/**
 * Start an ack extension timer that periodically calls `msg.working()`.
 *
 * @returns Cleanup function to stop the timer, or `null` if disabled.
 */
export const startAckExtensionTimer = (
  msg: { working(): void },
  interval: number | null,
): (() => void) | null => {
  if (!interval) return null;

  const timer = setInterval(() => {
    try {
      msg.working();
    } catch {
      // Connection degraded — handler will settle soon
    }
  }, interval);

  return () => {
    clearInterval(timer);
  };
};
