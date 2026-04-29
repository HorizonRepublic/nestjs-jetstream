import type { MsgHdrs } from '@nats-io/transport-node';

/** Discriminates the kind of message routed through the transport. */
export enum MessageKind {
  Event = 'event',
  Rpc = 'rpc',
}

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
}

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
