/** Minimal logger surface needed by {@link settleQuietly} — matches NestJS Logger. */
export interface SettleLogger {
  error(message: string, error?: unknown): void;
}

/**
 * Settlement calls (ack/nak/term) are publishes and throw on a degraded
 * connection — log instead of letting that kill routing or the process.
 */
export const settleQuietly = (logger: SettleLogger, label: string, action: () => void): void => {
  try {
    action();
  } catch (err) {
    logger.error(label, err);
  }
};
