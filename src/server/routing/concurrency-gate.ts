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
 */
export class ConcurrencyGate {
  private active = 0;
  private backlogWarned = false;
  private readonly backlog: QueuedMessage[] = [];

  public constructor(
    private readonly maxActive: number,
    private readonly route: RouteFn,
    private readonly parkTimer: ParkTimerFn | null,
    private readonly logger: Logger,
    private readonly label: string,
  ) {}

  /** Entry point for each incoming message. */
  public push(msg: JsMsg): void {
    if (this.active >= this.maxActive) {
      // A parked message's ack_wait clock is already running on the server.
      this.backlog.push({
        msg,
        stopAckExtension: this.parkTimer ? this.parkTimer(msg) : null,
      });

      if (!this.backlogWarned && this.backlog.length >= BACKLOG_WARN_THRESHOLD) {
        this.backlogWarned = true;
        this.logger.warn(
          `${this.label} backlog reached ${this.backlog.length} messages — consumer may be falling behind`,
        );
      }

      return;
    }

    this.active++;
    const result = this.routeSafely(msg);

    if (result !== undefined) {
      this.trackAsync(result, msg);
    } else {
      this.active--;
      if (this.backlog.length > 0) this.drainBacklog();
    }
  }

  /** Stop parked timers and drop the backlog. */
  public dispose(): void {
    for (const queued of this.backlog) {
      queued.stopAckExtension?.();
    }

    this.backlog.length = 0;
  }

  private readonly onAsyncDone = (): void => {
    this.active--;
    this.drainBacklog();
  };

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
