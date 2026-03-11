import type { MsgHdrs } from 'nats';

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
}

/**
 * Hook callbacks for transport lifecycle and operational events.
 *
 * Each hook has a default implementation that logs via NestJS Logger.
 * Providing a custom hook replaces the default for that specific event.
 * Hooks that are not overridden continue using the Logger fallback.
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
  [TransportEvent.MessageRouted](subject: string, kind: 'rpc' | 'event'): void;

  /** Fired at the start of the graceful shutdown sequence. */
  [TransportEvent.ShutdownStart](): void;

  /** Fired after graceful shutdown completes. */
  [TransportEvent.ShutdownComplete](): void;

  /** Fired when a message exhausts all delivery attempts (dead letter). */
  [TransportEvent.DeadLetter](info: DeadLetterInfo): void;
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
