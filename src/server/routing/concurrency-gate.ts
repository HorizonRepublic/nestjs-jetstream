import type { Logger } from '@nestjs/common';

import type { JsMsg } from '@nats-io/jetstream';

import type { ParkTimerFn, RouteFn } from './routing.types';

/** A message parked in the backlog with its ack-extension timer. */
interface QueuedMessage {
  readonly msg: JsMsg;
  readonly stopAckExtension: (() => void) | null;
}

const BACKLOG_WARN_THRESHOLD = 1_000;

/**
 * Concurrency limiter for the routing pipeline: up to `maxActive` messages
 * are routed in parallel, anything beyond queues FIFO and drains as each
 * in-flight message completes. Ordered streams pin the limit to 1 so
 * delivery stays strictly sequential.
 *
 * Parked messages are kept alive only while handlers make progress. Once no
 * slot has freed for `stallLimitMs`, every slot is held by a hung handler:
 * the backlog goes back to the server, and so does every message arriving
 * until a slot frees, so other pods can take them.
 */
export class ConcurrencyGate {
  private active = 0;
  private backlogWarned = false;
  private readonly backlog: QueuedMessage[] = [];
  /** When a handler last started or finished. */
  private lastProgressAt = Date.now();
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private stalled = false;

  public constructor(
    private readonly maxActive: number,
    private readonly route: RouteFn,
    private readonly parkTimer: ParkTimerFn | null,
    private readonly logger: Logger,
    private readonly label: string,
    private readonly stallLimitMs: number = Number.POSITIVE_INFINITY,
  ) {}

  /** Entry point for each incoming message. */
  public push(msg: JsMsg): void {
    if (this.active >= this.maxActive) {
      if (this.stalled || Date.now() - this.lastProgressAt >= this.stallLimitMs) {
        this.stalled = true;
        this.handBack(msg);

        return;
      }

      // A parked message's ack_wait clock is already running on the server.
      this.backlog.push({
        msg,
        stopAckExtension: this.parkTimer ? this.parkTimer(msg) : null,
      });

      if (!this.backlogWarned && this.backlog.length >= BACKLOG_WARN_THRESHOLD) {
        this.backlogWarned = true;
        this.logger.warn(
          `${this.label} backlog reached ${this.backlog.length} messages; consumer may be falling behind`,
        );
      }

      this.armStallTimer();

      return;
    }

    this.start(msg);
  }

  /**
   * Stop parked timers and hand the backlog back to the server. Dropping it
   * silently left every parked message waiting out ack_wait before another
   * pod could pick it up, which is the whole cost of a rolling deploy.
   */
  public dispose(): void {
    this.clearStallTimer();
    this.releaseBacklog();
  }

  private readonly onAsyncDone = (): void => {
    this.active--;
    this.markProgress();
    this.drainBacklog();
  };

  private readonly onStallCheck = (): void => {
    this.stallTimer = null;

    if (this.backlog.length === 0) return;

    if (Date.now() - this.lastProgressAt < this.stallLimitMs) {
      this.armStallTimer();

      return;
    }

    this.stalled = true;
    this.logger.warn(
      `${this.label}: no handler finished in ${this.stallLimitMs}ms; handing ${this.backlog.length} queued messages back to the server`,
    );
    this.releaseBacklog();
  };

  private start(msg: JsMsg): void {
    this.active++;
    this.markProgress();
    const result = this.routeSafely(msg);

    if (result !== undefined) {
      this.trackAsync(result, msg);
    } else {
      this.active--;
      if (this.backlog.length > 0) this.drainBacklog();
    }
  }

  private markProgress(): void {
    this.lastProgressAt = Date.now();
    this.stalled = false;
  }

  private armStallTimer(): void {
    if (this.stallTimer !== null || !Number.isFinite(this.stallLimitMs)) return;

    const delay = Math.max(0, this.lastProgressAt + this.stallLimitMs - Date.now());
    const timer = setTimeout(this.onStallCheck, delay);

    if (typeof timer.unref === 'function') timer.unref();
    this.stallTimer = timer;
  }

  private clearStallTimer(): void {
    if (this.stallTimer === null) return;
    clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private releaseBacklog(): void {
    for (const queued of this.backlog) {
      queued.stopAckExtension?.();
      this.handBack(queued.msg);
    }

    this.backlog.length = 0;
    this.backlogWarned = false;
  }

  private handBack(msg: JsMsg): void {
    try {
      msg.nak();
    } catch {
      // A closing connection cannot carry the nak; the server redelivers
      // once ack_wait expires either way.
    }
  }

  /** A throw here must not leak the concurrency slot or kill the subscription. */
  private routeSafely(msg: JsMsg): Promise<void> | undefined {
    try {
      return this.route(msg);
    } catch (err) {
      this.logger.error(`Unexpected routing failure for ${msg.subject}:`, err);

      return undefined;
    }
  }

  private trackAsync(result: Promise<void>, msg: JsMsg): void {
    void result
      .catch((err: unknown) => {
        this.logger.error(`Unexpected routing failure for ${msg.subject}:`, err);
      })
      .finally(this.onAsyncDone);
  }

  private drainBacklog(): void {
    while (this.active < this.maxActive) {
      const next = this.backlog.shift();

      if (next === undefined) break;

      next.stopAckExtension?.();
      this.active++;
      this.markProgress();
      const result = this.routeSafely(next.msg);

      if (result !== undefined) {
        this.trackAsync(result, next.msg);
      } else {
        this.active--;
      }
    }

    if (this.backlog.length < BACKLOG_WARN_THRESHOLD) this.backlogWarned = false;
  }
}
