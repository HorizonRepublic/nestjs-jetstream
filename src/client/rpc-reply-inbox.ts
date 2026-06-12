import { Logger } from '@nestjs/common';
import {
  createInbox,
  type Msg,
  type NatsConnection,
  type Subscription,
} from '@nats-io/transport-node';

import type { Codec } from '../interfaces';
import { JetstreamHeader } from '../jetstream.constants';

import type { RpcReplyCallback } from './client.types';

/**
 * Shared reply inbox for JetStream-mode RPC: one NATS subscription routes
 * every reply to its pending callback by correlation ID, with a deadline
 * timer per in-flight request.
 */
export class RpcReplyInbox {
  private readonly logger = new Logger('Jetstream:RpcInbox');

  private inbox: string | null = null;
  private subscription: Subscription | null = null;
  private readonly pending = new Map<string, RpcReplyCallback>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  public constructor(
    private readonly codec: Codec,
    private readonly inboxPrefix: string,
  ) {}

  /** Reply-to subject for outgoing requests; null until {@link setup} ran. */
  public get address(): string | null {
    return this.inbox;
  }

  /** True while the inbox subscription is live. */
  public get active(): boolean {
    return this.subscription !== null;
  }

  /** Create the inbox subject and subscribe reply routing on it. */
  public setup(nc: NatsConnection): void {
    this.inbox = createInbox(this.inboxPrefix);

    this.subscription = nc.subscribe(this.inbox, {
      callback: (err, msg) => {
        if (err) {
          this.logger.error('Inbox subscription error:', err);

          return;
        }

        this.route(msg);
      },
    });

    this.logger.debug(`Inbox subscription: ${this.inbox}`);
  }

  /** Register the callback that settles the round-trip for `correlationId`. */
  public register(correlationId: string, callback: RpcReplyCallback): void {
    this.pending.set(correlationId, callback);
  }

  /**
   * Arm the request deadline. When it fires while the request is still
   * pending, both registry entries are removed before `onExpired` runs.
   */
  public armTimeout(correlationId: string, ms: number, onExpired: () => void): void {
    const timeoutId = setTimeout(() => {
      if (!this.pending.has(correlationId)) return;

      this.timeouts.delete(correlationId);
      this.pending.delete(correlationId);
      onExpired();
    }, ms);

    this.timeouts.set(correlationId, timeoutId);
  }

  /** True while the request has not been settled or discarded. */
  public has(correlationId: string): boolean {
    return this.pending.has(correlationId);
  }

  /**
   * Drop a request without invoking its callback: clears the deadline and
   * returns whether the request was still pending.
   */
  public discard(correlationId: string): boolean {
    const timeoutId = this.timeouts.get(correlationId);

    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      this.timeouts.delete(correlationId);
    }

    return this.pending.delete(correlationId);
  }

  /** Fail every pending request with `error` and tear the inbox down. */
  public rejectAll(error: Error): void {
    for (const callback of this.pending.values()) {
      callback({ err: error, response: null, isDisposed: true });
    }

    for (const timeoutId of this.timeouts.values()) {
      clearTimeout(timeoutId);
    }

    this.pending.clear();
    this.timeouts.clear();
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.inbox = null;
  }

  /** Route an inbox reply to the matching pending callback. */
  private route(msg: Msg): void {
    const correlationId = msg.headers?.get(JetstreamHeader.CorrelationId);

    if (!correlationId) {
      this.logger.warn('Inbox reply without correlation-id, ignoring');

      return;
    }

    const callback = this.pending.get(correlationId);

    if (!callback) {
      this.logger.warn(`No pending handler for correlation-id: ${correlationId}`);

      return;
    }

    const timeoutId = this.timeouts.get(correlationId);

    if (timeoutId) {
      clearTimeout(timeoutId);
      this.timeouts.delete(correlationId);
    }

    try {
      const decoded = this.codec.decode(msg.data);

      if (msg.headers?.get(JetstreamHeader.Error)) {
        callback({ err: decoded, response: null, isDisposed: true });
      } else {
        callback({ err: null, response: decoded, isDisposed: true });
      }
    } catch (err) {
      callback({
        err: err instanceof Error ? err : new Error('Decode error'),
        response: null,
        isDisposed: true,
      });
    } finally {
      this.pending.delete(correlationId);
    }
  }
}
