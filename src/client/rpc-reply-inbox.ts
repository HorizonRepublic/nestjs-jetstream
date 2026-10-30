import { Logger } from '@nestjs/common';
import type { WritePacket } from '@nestjs/microservices';

import {
  createInbox,
  type Msg,
  type NatsConnection,
  type Subscription,
} from '@nats-io/transport-node';

import { JetstreamRpcError, RpcErrorReason } from '../errors';
import type { Codec } from '../interfaces';
import { JetstreamHeader } from '../jetstream.constants';
import type { RpcCancelCallback, RpcReplyCallback } from './client.types';

interface PendingReply {
  readonly settle: RpcReplyCallback;
  readonly cancel: RpcCancelCallback | undefined;
}

/**
 * Shared reply inbox for JetStream-mode RPC: one NATS subscription routes
 * every reply to its pending callback by correlation ID, with a deadline
 * timer per in-flight request.
 */
export class RpcReplyInbox {
  private readonly logger = new Logger('Jetstream:RpcInbox');

  private inbox: string | null = null;
  private subscription: Subscription | null = null;
  private readonly pending = new Map<string, PendingReply>();
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

  /**
   * Register the callbacks that settle the round-trip for `correlationId`:
   * `callback` on a reply or failure, `onCancel` when the caller gives up.
   */
  public register(
    correlationId: string,
    callback: RpcReplyCallback,
    onCancel?: RpcCancelCallback | undefined,
  ): void {
    this.pending.set(correlationId, { settle: callback, cancel: onCancel });
  }

  /**
   * Arm the request deadline. When it fires while the request is still
   * pending, both registry entries are removed before `onExpired` runs.
   */
  public armTimeout(correlationId: string, ms: number, onExpired: () => void): void {
    const existing = this.timeouts.get(correlationId);

    if (existing !== undefined) clearTimeout(existing);

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

  /** Drop a request the caller stopped waiting for and run its cancel callback, if still pending. */
  public cancel(correlationId: string): void {
    const entry = this.pending.get(correlationId);

    if (!entry) return;

    this.discard(correlationId);
    entry.cancel?.();
  }

  /** Fail every pending request with `error` and tear the inbox down. */
  public rejectAll(error: Error): void {
    const entries = [...this.pending.values()];

    for (const timeoutId of this.timeouts.values()) {
      clearTimeout(timeoutId);
    }

    // Cleared first: a callback may unsubscribe its caller, which cancels the same id.
    this.pending.clear();
    this.timeouts.clear();
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.inbox = null;

    for (const entry of entries) {
      entry.settle({ err: error, response: null, isDisposed: true });
    }
  }

  /** Route an inbox reply to the matching pending callback. */
  private route(msg: Msg): void {
    const correlationId = msg.headers?.get(JetstreamHeader.CorrelationId);

    if (!correlationId) {
      this.logger.warn('Inbox reply without correlation-id, ignoring');

      return;
    }

    const entry = this.pending.get(correlationId);

    if (!entry) {
      this.logger.warn(`No pending handler for correlation-id: ${correlationId}`);

      return;
    }

    this.discard(correlationId);

    let packet: WritePacket;

    try {
      const decoded = this.codec.decode(msg.data);

      packet = msg.headers?.get(JetstreamHeader.Error)
        ? { err: decoded, response: null, isDisposed: true }
        : { err: null, response: decoded, isDisposed: true };
    } catch (err) {
      packet = {
        err:
          err instanceof Error
            ? err
            : new JetstreamRpcError(RpcErrorReason.DecodeFailed, 'Decode error', { cause: err }),
        response: null,
        isDisposed: true,
      };
    }

    entry.settle(packet);
  }
}
