import { Logger } from '@nestjs/common';

import type { TransportHooks } from '../interfaces';

/**
 * Central event bus for transport lifecycle notifications.
 *
 * Dispatches events to user-provided hooks. Events without a
 * registered hook are silently ignored — no default logging.
 *
 * @example
 * ```typescript
 * const bus = new EventBus(logger, {
 *   [TransportEvent.Error]: (err) => sentry.captureException(err),
 * });
 *
 * bus.emit(TransportEvent.Error, new Error('timeout'), 'rpc-router');
 * // → calls sentry
 *
 * bus.emit(TransportEvent.Connect, 'nats://localhost:4222');
 * // → no-op (no hook registered)
 * ```
 */
export class EventBus {
  private readonly hooks: Partial<TransportHooks>;
  private readonly logger: Logger;

  public constructor(logger: Logger, hooks?: Partial<TransportHooks>) {
    this.logger = logger;
    this.hooks = hooks ?? {};
  }

  /**
   * Emit a lifecycle event. Dispatches to custom hook if registered, otherwise no-op.
   *
   * @param event - The {@link TransportEvent} to emit.
   * @param args - Arguments matching the hook signature for this event.
   */
  public emit<K extends keyof TransportHooks>(
    event: K,
    ...args: Parameters<TransportHooks[K]>
  ): void {
    const hook = this.hooks[event];

    if (!hook) return;

    try {
      const result = (hook as (...a: unknown[]) => unknown)(...args);

      // Catch async hook rejections that would otherwise go to unhandledRejection
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch((err: unknown) => {
          this.logger.error(
            `Async hook "${event}" rejected: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    } catch (err) {
      this.logger.error(
        `Hook "${event}" threw an error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
