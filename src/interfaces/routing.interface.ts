import type { MessageHandler } from '@nestjs/microservices';

import type { DeadLetterInfo } from './hooks.interface';

/** @internal Entry stored in the pattern registry after handler registration. */
export interface RegisteredHandler {
  /** NestJS message handler function. */
  handler: MessageHandler;
  /** Normalized NATS subject pattern. */
  pattern: string;
  /** `true` if this handler was registered via `@EventPattern`. */
  isEvent: boolean;
  /** `true` if this handler uses broadcast delivery (fan-out to all consumers). */
  isBroadcast: boolean;
  /** `true` if this handler uses ordered delivery (strict sequential processing). */
  isOrdered: boolean;
}

/** @internal Grouped pattern lists by stream kind, used for stream/consumer setup. */
export interface PatternsByKind {
  /** Workqueue event patterns. */
  events: string[];
  /** RPC command patterns. */
  commands: string[];
  /** Broadcast event patterns. */
  broadcasts: string[];
  /** Ordered event patterns (strict sequential delivery). */
  ordered: string[];
}

/** Options for configuring event/broadcast processing behavior. */
export interface EventProcessingConfig {
  events?: { concurrency?: number; ackExtension?: boolean | number };
  broadcast?: { concurrency?: number; ackExtension?: boolean | number };
}

/** Options for dead letter queue handling. */
export interface DeadLetterConfig {
  /**
   * Map of stream name -> max_deliver value.
   * Used to detect when a message from a given stream has exhausted all delivery attempts.
   */
  maxDeliverByStream: Map<string, number>;
  /** Async callback invoked when a message exhausts all deliveries. */
  onDeadLetter(info: DeadLetterInfo): Promise<void>;
}

/** Options for configuring RPC processing behavior. */
export interface RpcRouterOptions {
  timeout?: number;
  concurrency?: number;
  ackExtension?: boolean | number;
}
