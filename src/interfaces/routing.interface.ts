import type { MessageHandler } from '@nestjs/microservices';

/** Entry stored in the pattern registry. */
export interface RegisteredHandler {
  handler: MessageHandler;
  pattern: string;
  isEvent: boolean;
  isBroadcast: boolean;
}

/** Grouped pattern lists by stream kind. */
export interface PatternsByKind {
  events: string[];
  commands: string[];
  broadcasts: string[];
}
