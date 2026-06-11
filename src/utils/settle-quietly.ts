/** Minimal logger surface needed by {@link settleQuietly} — matches NestJS Logger. */
export interface SettleLogger {
  error(message: string, error?: unknown): void;
}

/**
 * Run a message-settlement call (`ack`/`nak`/`term`) that may throw when the
 * connection is degraded — settlement is a publish under the hood. The error
 * is logged instead of propagated so a dying connection cannot take a routing
 * subscription or the process down with it; the unsettled message redelivers
 * via `ack_wait` once the connection recovers.
 */
export const settleQuietly = (logger: SettleLogger, label: string, action: () => void): void => {
  try {
    action();
  } catch (err) {
    logger.error(label, err);
  }
};
