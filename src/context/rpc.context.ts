import { BaseRpcContext } from '@nestjs/microservices';
import type { Msg, MsgHdrs } from '@nats-io/transport-node';
import type { JsMsg } from '@nats-io/jetstream';

import { JetstreamHeader } from '../jetstream.constants';

type NatsMessage = JsMsg | Msg;

/**
 * Execution context for RPC and event handlers.
 *
 * Provides convenient accessors for the NATS message, subject,
 * headers, and JetStream metadata without needing to interact
 * with the raw message directly.
 *
 * Handlers can also control message settlement via {@link retry}
 * and {@link terminate} instead of throwing errors.
 *
 * @example
 * ```typescript
 * @EventPattern('order.process')
 * async handle(@Payload() data: OrderDto, @Ctx() ctx: RpcContext) {
 *   if (ctx.getDeliveryCount()! >= 3) {
 *     ctx.terminate('Max business retries exceeded');
 *     return;
 *   }
 *   if (!this.isReady()) {
 *     ctx.retry({ delay: 5000 });
 *     return;
 *   }
 *   await this.process(data);
 * }
 * ```
 */
export class RpcContext extends BaseRpcContext<[NatsMessage]> {
  private _shouldRetry = false;
  private _retryDelay: number | undefined;
  private _shouldTerminate = false;
  private _terminateReason: string | undefined;

  // ---------------------------------------------------------------------------
  // Message accessors
  // ---------------------------------------------------------------------------

  /**
   * Get the underlying NATS message.
   *
   * @returns `JsMsg` for JetStream handlers, `Msg` for Core RPC handlers.
   */
  public getMessage(): NatsMessage {
    return this.args[0];
  }

  /** @returns The NATS subject this message was published to. */
  public getSubject(): string {
    return this.args[0].subject;
  }

  /** @returns All NATS message headers, or `undefined` if none are present. */
  public getHeaders(): MsgHdrs | undefined {
    return this.args[0].headers;
  }

  /**
   * Get a single header value by key.
   *
   * @param key - Header name (e.g. `'x-trace-id'`).
   * @returns Header value, or `undefined` if the header is missing.
   */
  public getHeader(key: string): string | undefined {
    return this.args[0].headers?.get(key);
  }

  /**
   * Type guard: returns `true` when the message is a JetStream message.
   *
   * Narrows `getMessage()` return type to `JsMsg`, giving access to
   * `ack()`, `nak()`, `term()`, and delivery metadata.
   */
  public isJetStream(): this is RpcContext & { getMessage(): JsMsg } {
    return 'ack' in this.args[0];
  }

  // ---------------------------------------------------------------------------
  // JetStream metadata (return undefined for Core NATS messages)
  // ---------------------------------------------------------------------------

  /** How many times this message has been delivered. */
  public getDeliveryCount(): number | undefined {
    return this.asJetStream()?.info.deliveryCount;
  }

  /** The JetStream stream this message belongs to. */
  public getStream(): string | undefined {
    return this.asJetStream()?.info.stream;
  }

  /** The stream sequence number. */
  public getSequence(): number | undefined {
    return this.asJetStream()?.seq;
  }

  /** The message timestamp as a `Date` (derived from `info.timestampNanos`). */
  public getTimestamp(): Date | undefined {
    const nanos = this.asJetStream()?.info.timestampNanos;

    return typeof nanos === 'number' ? new Date(nanos / 1_000_000) : undefined;
  }

  /** The name of the service that published this message (from `x-caller-name` header). */
  public getCallerName(): string | undefined {
    return this.getHeader(JetstreamHeader.CallerName);
  }

  // ---------------------------------------------------------------------------
  // Handler-controlled settlement
  // ---------------------------------------------------------------------------

  /**
   * Signal the transport to retry (nak) this message instead of acknowledging it.
   *
   * Use for business-level retries without throwing errors.
   * Only affects JetStream event handlers (workqueue/broadcast).
   *
   * @param opts - Optional delay in ms before redelivery.
   * @throws Error if {@link terminate} was already called.
   */
  public retry(opts?: { delayMs?: number }): void {
    this.assertJetStream('retry');

    if (this._shouldTerminate) {
      throw new Error('Cannot retry — terminate() was already called');
    }

    this._shouldRetry = true;
    this._retryDelay = opts?.delayMs;
  }

  /**
   * Signal the transport to permanently reject (term) this message.
   *
   * Use when a message is no longer relevant and should not be retried or sent to DLQ.
   * Only affects JetStream event handlers (workqueue/broadcast).
   *
   * @param reason - Optional reason for termination (logged by NATS).
   * @throws Error if {@link retry} was already called.
   */
  public terminate(reason?: string): void {
    this.assertJetStream('terminate');

    if (this._shouldRetry) {
      throw new Error('Cannot terminate — retry() was already called');
    }

    this._shouldTerminate = true;
    this._terminateReason = reason;
  }

  /** Narrow to JsMsg or return null for Core messages. Used by metadata getters. */
  private asJetStream(): JsMsg | null {
    return this.isJetStream() ? (this.args[0] as JsMsg) : null;
  }

  /** Ensure the message is JetStream — settlement actions are not available for Core NATS. */
  private assertJetStream(method: string): void {
    if (!this.isJetStream()) {
      throw new Error(`${method}() is only available for JetStream messages`);
    }
  }

  // ---------------------------------------------------------------------------
  // Transport-facing state (read by EventRouter)
  // ---------------------------------------------------------------------------

  /** @internal */
  public get shouldRetry(): boolean {
    return this._shouldRetry;
  }

  /** @internal */
  public get retryDelay(): number | undefined {
    return this._retryDelay;
  }

  /** @internal */
  public get shouldTerminate(): boolean {
    return this._shouldTerminate;
  }

  /** @internal */
  public get terminateReason(): string | undefined {
    return this._terminateReason;
  }
}
