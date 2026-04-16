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
  if (typeof config === 'number') {
    if (!Number.isFinite(config) || config <= 0) return null;
    return Math.floor(config);
  }

  if (!ackWaitNanos) return DEFAULT_ACK_EXTENSION_INTERVAL;

  // ack_wait is reported in nanoseconds; convert to ms and halve so the
  // extension fires well before the deadline.
  const interval = Math.floor(ackWaitNanos / 1_000_000 / 2);

  return Math.max(interval, MIN_ACK_EXTENSION_INTERVAL);
};

interface AckEntry {
  msg: { working(): void };
  interval: number;
  nextFireAt: number;
  active: boolean;
}

/**
 * Process-wide pool that drives ack extension for every in-flight message
 * through a single adaptive `setTimeout`.
 *
 * Each entry tracks its own next-fire deadline. The pool keeps one timer
 * scheduled for the earliest deadline across all active entries; on fire it
 * walks the live set, calls `msg.working()` on every entry whose deadline
 * has passed, and re-schedules for the new earliest.
 *
 * The timer is marked `.unref()` so the pool cannot keep the event loop
 * alive on its own — lifecycle management is the caller's responsibility
 * (every `schedule()` must be paired with a `cancel()`).
 */
class AckExtensionPool {
  private readonly entries = new Set<AckEntry>();
  private handle: ReturnType<typeof setTimeout> | null = null;
  private handleFireAt = 0;

  public schedule(msg: { working(): void }, interval: number): AckEntry {
    const entry: AckEntry = {
      msg,
      interval,
      nextFireAt: Date.now() + interval,
      active: true,
    };

    this.entries.add(entry);
    this.ensureWake(entry.nextFireAt);

    return entry;
  }

  public cancel(entry: AckEntry): void {
    if (!entry.active) return;
    entry.active = false;
    this.entries.delete(entry);
    if (this.entries.size === 0 && this.handle !== null) {
      clearTimeout(this.handle);
      this.handle = null;
      this.handleFireAt = 0;
    }
  }

  /**
   * Ensure the shared timer will fire no later than `dueAt`. If an earlier
   * wake is already scheduled, leave it; otherwise replace it with a tighter one.
   */
  private ensureWake(dueAt: number): void {
    if (this.handle !== null && this.handleFireAt <= dueAt) return;
    if (this.handle !== null) clearTimeout(this.handle);

    const delay = Math.max(0, dueAt - Date.now());
    const handle = setTimeout(() => {
      this.tick();
    }, delay);

    if (typeof handle.unref === 'function') handle.unref();
    this.handle = handle;
    this.handleFireAt = dueAt;
  }

  private tick(): void {
    this.handle = null;
    this.handleFireAt = 0;

    const now = Date.now();
    let earliest = Infinity;

    for (const entry of this.entries) {
      if (!entry.active) continue;
      if (entry.nextFireAt <= now) {
        try {
          entry.msg.working();
        } catch {
          // `working()` fails when the NATS connection is degraded; the
          // handler will settle the message itself once it finishes.
        }

        entry.nextFireAt = now + entry.interval;
      }

      if (entry.nextFireAt < earliest) earliest = entry.nextFireAt;
    }

    if (earliest !== Infinity) this.ensureWake(earliest);
  }
}

const pool = new AckExtensionPool();

/**
 * Register a message for ack extension. While the entry is live the pool
 * periodically calls `msg.working()` at the configured interval to keep
 * NATS from redelivering before the handler finishes.
 *
 * @returns Cleanup function that cancels the registration, or `null` when
 *          ack extension is disabled.
 */
export const startAckExtensionTimer = (
  msg: { working(): void },
  interval: number | null,
): (() => void) | null => {
  if (interval === null || interval <= 0) return null;
  const entry = pool.schedule(msg, interval);

  return () => {
    pool.cancel(entry);
  };
};

/**
 * Internal — exposed for tests only.
 * @internal
 */
export const _ackExtensionPoolForTest = pool;
