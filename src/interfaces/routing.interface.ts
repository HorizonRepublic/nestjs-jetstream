import type { MessageHandler } from '@nestjs/microservices';

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
