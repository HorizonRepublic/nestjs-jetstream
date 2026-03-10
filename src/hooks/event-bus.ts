import { Logger } from '@nestjs/common';

import { TransportEvent } from '../interfaces';
import type { TransportHooks } from '../interfaces';

/**
 * Central event bus for transport lifecycle notifications.
 *
 * Dispatches events to user-provided hooks or falls back to
 * the NestJS Logger for each event type independently.
 *
 * @example
 * ```typescript
 * const bus = new EventBus(logger, {
 *   [TransportEvent.Error]: (err) => sentry.captureException(err),
 * });
 *
 * bus.emit(TransportEvent.Error, new Error('timeout'), 'rpc-router');
 * // → calls sentry, not logger
 *
 * bus.emit(TransportEvent.Connect, 'nats://localhost:4222');
 * // → calls logger.log (no custom hook for connect)
 * ```
 */
export class EventBus {
  private readonly hooks: Partial<TransportHooks>;
  private readonly logger: Logger;

  public constructor(logger: Logger, hooks?: Partial<TransportHooks>) {
    this.logger = logger;
    this.hooks = hooks ?? {};
  }

  /** Emit a lifecycle event. Dispatches to custom hook or Logger fallback. */
  public emit<K extends keyof TransportHooks>(
    event: K,
    ...args: Parameters<TransportHooks[K]>
  ): void {
    const hook = this.hooks[event];

    if (hook) {
      try {
        (hook as (...a: unknown[]) => void)(...args);
      } catch (err) {
        this.logger.error(
          `Hook "${event}" threw an error: ${err instanceof Error ? err.message : err}`,
        );
      }

      return;
    }

    this.defaultHandler(event, args);
  }

  /** Default Logger-based handlers for each event type. */
  private defaultHandler(event: keyof TransportHooks, args: unknown[]): void {
    switch (event) {
      case TransportEvent.Connect:
        this.logger.log(`Connected to NATS: ${args[0]}`);
        break;
      case TransportEvent.Disconnect:
        this.logger.warn('NATS connection lost');
        break;
      case TransportEvent.Reconnect:
        this.logger.log(`Reconnected to NATS: ${args[0]}`);
        break;
      case TransportEvent.Error:
        this.logger.error(`Transport error: ${args[0]}`, args[1] ?? '');
        break;
      case TransportEvent.RpcTimeout:
        this.logger.warn(`RPC timeout: ${args[0]} (cid: ${args[1]})`);
        break;
      case TransportEvent.ConsumerLag:
        this.logger.warn(`Consumer lag: ${args[0]} has ${args[1]} pending`);
        break;
      case TransportEvent.MessageRouted:
        this.logger.debug(`Message routed: ${args[0]} [${args[1]}]`);
        break;
      case TransportEvent.ShutdownStart:
        this.logger.log('Graceful shutdown initiated');
        break;
      case TransportEvent.ShutdownComplete:
        this.logger.log('Graceful shutdown complete');
        break;
    }
  }
}
