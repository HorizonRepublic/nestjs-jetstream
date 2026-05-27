import type { MsgHdrs } from '@nats-io/transport-node';

import { StreamKind } from './stream.interface';

/** Discriminates the kind of message routed through the transport. */
export enum MessageKind {
  Event = 'event',
  Rpc = 'rpc',
}

/** Outcome of a handler invocation, used as a label on processing metrics. */
export type HandlerStatus = 'success' | 'error' | 'retried' | 'terminated';

/**
 * Outcome of a client publish (event emit or RPC publish leg). Outbound
 * operations either acknowledge cleanly or surface a transport error — there
 * is no retried/terminated dimension at the publish boundary.
 */
export type PublishStatus = 'success' | 'error';

/**
 * Outcome of a full RPC round-trip from the caller's perspective. Adds the
 * `timeout` dimension on top of {@link PublishStatus} so percentile analysis
 * can distinguish slow successes from deadline-exceeded calls.
 */
export type RpcOutcomeStatus = 'success' | 'error' | 'timeout';

export enum TransportEvent {
  Connect = 'connect',
  Disconnect = 'disconnect',
  Reconnect = 'reconnect',
  Error = 'error',
  RpcTimeout = 'rpcTimeout',
  MessageRouted = 'messageRouted',
  ShutdownStart = 'shutdownStart',
  ShutdownComplete = 'shutdownComplete',
  DeadLetter = 'deadLetter',
  ConsumerRecovered = 'consumerRecovered',
  HandlerCompleted = 'handlerCompleted',
  Published = 'published',
  RpcCompleted = 'rpcCompleted',
}

/**
 * Hook callbacks for transport lifecycle and operational events.
 *
 * Events without a registered hook are silently ignored.
 * Register hooks via `forRoot({ hooks: { ... } })` for monitoring,
 * alerting, or custom observability integration.
 *
 * @example
 * ```typescript
 * JetstreamModule.forRoot({
 *   hooks: {
 *     [TransportEvent.Error]: (error, context) => sentry.captureException(error),
 *     [TransportEvent.RpcTimeout]: (subject) => metrics.increment('rpc.timeout'),
 *   },
 * })
 * ```
 */
export interface TransportHooks {
  /** Fired when NATS connection is established. */
  [TransportEvent.Connect](server: string): void;

  /** Fired when NATS connection is lost. */
  [TransportEvent.Disconnect](): void;

  /** Fired when NATS connection is re-established after a disconnect. */
  [TransportEvent.Reconnect](server: string): void;

  /** Fired on any transport-level error. */
  [TransportEvent.Error](error: Error, context?: string): void;

  /** Fired when an RPC handler exceeds its timeout. */
  [TransportEvent.RpcTimeout](subject: string, correlationId: string): void;

  /** Fired after a message is successfully routed to its handler. */
  [TransportEvent.MessageRouted](subject: string, kind: MessageKind): void;

  /** Fired at the start of the graceful shutdown sequence. */
  [TransportEvent.ShutdownStart](): void;

  /** Fired after graceful shutdown completes. */
  [TransportEvent.ShutdownComplete](): void;

  /** Fired when a message exhausts all delivery attempts (dead letter). */
  [TransportEvent.DeadLetter](info: DeadLetterInfo): void;

  /**
   * Fired when a consumer's self-healing flow successfully recovers after
   * one or more failed restart attempts. Useful for "service is back" alerts
   * and to balance the noise from preceding error/restart logs.
   *
   * @param label   Stream kind label (`event`, `broadcast`, `ordered`, etc.)
   *                or consumer name passed to `createSelfHealingFlow`.
   * @param attempts How many consecutive failed attempts preceded the recovery.
   */
  [TransportEvent.ConsumerRecovered](label: string, attempts: number): void;

  /**
   * Fired immediately after a handler returns or throws.
   *
   * Used by built-in metrics; users can register their own handler for
   * latency tracking, slow-handler alerting, or custom observability.
   *
   * @param subject  The declared NATS pattern (from `@EventPattern` / `@MessagePattern`).
   * @param kind     Stream kind: `Event`, `Command`, `Broadcast`, `Ordered`.
   * @param durationMs Wall-clock time in milliseconds from handler entry to settlement.
   * @param status   Outcome: `success`, `error`, `retried`, or `terminated`.
   */
  [TransportEvent.HandlerCompleted](
    subject: string,
    kind: StreamKind,
    durationMs: number,
    status: HandlerStatus,
  ): void;

  /**
   * Fired after every client-side publish (event emit or RPC publish leg)
   * completes, regardless of outcome.
   *
   * @param subject  Declared user pattern (e.g. `orders.created`) — bounded
   *                 by handler registration, safe for high-cardinality labels.
   * @param kind     Stream kind the publish targets: `Event`, `Broadcast`,
   *                 `Ordered`, or `Command` (RPC publish leg).
   * @param durationMs Wall-clock time from publish initiation to ack/error.
   * @param status   `success` when the publish acked, `error` otherwise.
   */
  [TransportEvent.Published](
    subject: string,
    kind: StreamKind,
    durationMs: number,
    status: PublishStatus,
  ): void;

  /**
   * Fired after an RPC round-trip completes from the caller's perspective —
   * either a reply is received, the call errors out, or the deadline expires.
   *
   * Distinct from {@link Published} which only covers the publish leg.
   *
   * @param subject  Declared command pattern (e.g. `orders.get`).
   * @param durationMs Wall-clock time from request initiation to settlement.
   * @param status   `success` for a successful reply, `error` for transport/
   *                 handler errors, `timeout` when the deadline expired.
   */
  [TransportEvent.RpcCompleted](
    subject: string,
    durationMs: number,
    status: RpcOutcomeStatus,
  ): void;
}

/**
 * Internal subscriber for a transport event. Multiple subscribers may be
 * registered per event via `EventBus.subscribe()` — used by built-in
 * observers (e.g. metrics) without overriding the user-provided hook.
 */
export type TransportEventSubscriber<K extends keyof TransportHooks> = (
  ...args: Parameters<TransportHooks[K]>
) => unknown;

/**
 * Context passed to the onDeadLetter callback when a message exhausts all delivery attempts.
 */
export interface DeadLetterInfo {
  /** The NATS subject the message was published to. */
  subject: string;
  /** Decoded message payload. */
  data: unknown;
  /** Message headers (raw NATS MsgHdrs). */
  headers: MsgHdrs | undefined;
  /** The error that caused the last handler failure. */
  error: unknown;
  /** How many times this message was delivered. */
  deliveryCount: number;
  /** The stream this message belongs to. */
  stream: string;
  /** The stream sequence number. */
  streamSequence: number;
  /** ISO timestamp of the message (derived from msg.info.timestampNanos). */
  timestamp: string;
}
