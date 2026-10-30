import { Logger } from '@nestjs/common';

import { ConfigErrorReason, JetstreamConfigError } from '../errors';
import type { AckExtensionConfig } from '../interfaces';
import type { AckExtension, AckExtensionTarget } from './ack-extension.types';

/** Default ack extension interval fallback when ack_wait is unknown (ms). */
const DEFAULT_ACK_EXTENSION_INTERVAL = 5_000;

/** Minimum ack extension interval to prevent excessive msg.working() calls (ms). */
const MIN_ACK_EXTENSION_INTERVAL = 500;

/**
 * How long a single message may be kept alive by extension unless
 * `ackExtension.maxDuration` says otherwise. A hung handler would otherwise
 * hold its message for the life of the process.
 */
export const DEFAULT_MAX_ACK_EXTENSION_MS = 300_000;

const logger = new Logger('Jetstream:AckExtension');

/** Half of ack_wait, so the extension fires well before the deadline. */
const intervalFromAckWait = (ackWaitNanos: number | undefined): number => {
  if (!ackWaitNanos) return DEFAULT_ACK_EXTENSION_INTERVAL;

  return Math.max(Math.floor(ackWaitNanos / 1_000_000 / 2), MIN_ACK_EXTENSION_INTERVAL);
};

const isPositive = (value: number): boolean => !Number.isNaN(value) && value > 0;

/**
 * Resolve the ack extension from user config and the consumer's ack_wait.
 *
 * @param config - `false`/`undefined` -> disabled, `true` -> interval from ack_wait,
 *   `number` -> explicit interval in ms, object -> interval and limit.
 * @param ackWaitNanos - Consumer `ack_wait` in nanoseconds.
 * @returns The interval and limit in ms, or `null` when disabled.
 * @throws When the object form carries an interval or limit that is not a positive number.
 */
export const resolveAckExtension = (
  config: AckExtensionConfig | undefined,
  ackWaitNanos: number | undefined,
): AckExtension | null => {
  if (config === false || config === undefined) return null;
  if (config === true) {
    return {
      intervalMs: intervalFromAckWait(ackWaitNanos),
      maxDurationMs: DEFAULT_MAX_ACK_EXTENSION_MS,
    };
  }

  if (typeof config === 'number') {
    if (!Number.isFinite(config) || config <= 0) return null;

    return { intervalMs: Math.floor(config), maxDurationMs: DEFAULT_MAX_ACK_EXTENSION_MS };
  }

  const { interval, maxDuration = DEFAULT_MAX_ACK_EXTENSION_MS } = config;

  if (interval !== undefined && (!Number.isFinite(interval) || interval <= 0)) {
    throw new JetstreamConfigError(
      ConfigErrorReason.InvalidAckExtension,
      `ackExtension.interval must be a positive number of milliseconds, got ${interval}.`,
    );
  }

  if (!isPositive(maxDuration)) {
    throw new JetstreamConfigError(
      ConfigErrorReason.InvalidAckExtension,
      `ackExtension.maxDuration must be a positive number of milliseconds or Infinity, got ${maxDuration}.`,
    );
  }

  return {
    intervalMs: interval === undefined ? intervalFromAckWait(ackWaitNanos) : Math.floor(interval),
    maxDurationMs: maxDuration,
  };
};

/**
 * Keep-alive for a message parked behind the concurrency limit. The server's
 * ack_wait clock runs from delivery, so a parked message is extended whether or
 * not `ackExtension` is on, and without its limit: that limit bounds handler
 * run time, while a parked message only waits for a slot.
 */
export const resolveParkExtension = (
  handlerExtension: AckExtension | null,
  ackWaitNanos: number | undefined,
): AckExtension => ({
  intervalMs: handlerExtension?.intervalMs ?? intervalFromAckWait(ackWaitNanos),
  maxDurationMs: Number.POSITIVE_INFINITY,
});

interface AckEntry {
  msg: AckExtensionTarget;
  interval: number;
  maxDuration: number;
  nextFireAt: number;
  expiresAt: number;
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
 * alive on its own; lifecycle management is the caller's responsibility
 * (every `schedule()` must be paired with a `cancel()`).
 */
class AckExtensionPool {
  private readonly entries = new Set<AckEntry>();
  private handle: ReturnType<typeof setTimeout> | null = null;
  private handleFireAt = 0;

  public schedule(msg: AckExtensionTarget, extension: AckExtension): AckEntry {
    const now = Date.now();
    const entry: AckEntry = {
      msg,
      interval: extension.intervalMs,
      maxDuration: extension.maxDurationMs,
      nextFireAt: now + extension.intervalMs,
      expiresAt: now + extension.maxDurationMs,
      active: true,
    };

    this.entries.add(entry);
    // Wake at the deadline too: with `interval` longer than `maxTotalMs` an
    // expired entry would otherwise linger until the next interval.
    this.ensureWake(Math.min(entry.nextFireAt, entry.expiresAt));

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

      if (entry.expiresAt <= now) {
        this.cancel(entry);
        logger.warn(
          `Stopped extending the ack deadline for ${entry.msg.subject} after ${entry.maxDuration}ms. ` +
            'The handler is still running; the server will redeliver the message once ack_wait ' +
            'runs out. Raise ackExtension.maxDuration if the handler legitimately runs this long.',
        );
        continue;
      }

      if (entry.nextFireAt <= now) {
        try {
          entry.msg.working();
        } catch {
          // `working()` fails when the NATS connection is degraded; the
          // handler will settle the message itself once it finishes.
        }

        entry.nextFireAt = now + entry.interval;
      }

      const dueAt = Math.min(entry.nextFireAt, entry.expiresAt);

      if (dueAt < earliest) earliest = dueAt;
    }

    if (earliest !== Infinity) this.ensureWake(earliest);
  }
}

const pool = new AckExtensionPool();

/**
 * Register a message for ack extension. The pool calls `msg.working()` at the
 * configured interval until the entry is cancelled or reaches its limit,
 * keeping NATS from redelivering before the handler finishes.
 *
 * @returns Cleanup function that cancels the registration, or `null` when
 *          ack extension is disabled.
 */
export const startAckExtensionTimer = (
  msg: AckExtensionTarget,
  extension: AckExtension | null,
): (() => void) | null => {
  if (extension === null || extension.intervalMs <= 0) return null;
  const entry = pool.schedule(msg, extension);

  return () => {
    pool.cancel(entry);
  };
};

/**
 * Internal, exposed for tests only.
 * @internal
 */
export const _ackExtensionPoolForTest: AckExtensionPool = pool;
