import { Logger } from '@nestjs/common';

import type { MessageKind, TransportEventSubscriber, TransportHooks } from '../interfaces';
import { TransportEvent } from '../interfaces';

/** Type-erased callable used internally to store hooks and subscribers homogeneously. */
type AnyTransportListener = (...args: unknown[]) => unknown;

/**
 * Central event bus for transport lifecycle notifications.
 *
 * Two emission paths:
 *  - User hooks registered via `forRoot({ hooks })` — at most one per event.
 *  - Internal subscribers added via `subscribe()` — many per event, used by
 *    metrics and other built-in observers.
 *
 * Both fire on every `emit()` call. Subscriber failures are isolated and
 * logged; they do not block other subscribers or the user hook.
 */
export class EventBus {
  private readonly hooks: Partial<TransportHooks>;
  private readonly logger: Logger;
  private readonly subscribers = new Map<keyof TransportHooks, AnyTransportListener[]>();

  public constructor(logger: Logger, hooks?: Partial<TransportHooks>) {
    this.logger = logger;
    this.hooks = hooks ?? {};
  }

  /**
   * Subscribe to a transport event. Used by built-in observers (e.g. metrics).
   * Multiple subscribers per event are supported; each is called independently.
   */
  public subscribe<K extends keyof TransportHooks>(
    event: K,
    handler: TransportEventSubscriber<K>,
  ): void {
    const list = this.subscribers.get(event) ?? [];

    list.push(handler as AnyTransportListener);
    this.subscribers.set(event, list);
  }

  /**
   * Emit a lifecycle event. Dispatches to all internal subscribers and the
   * registered user hook (if any).
   */
  public emit<K extends keyof TransportHooks>(
    event: K,
    ...args: Parameters<TransportHooks[K]>
  ): void {
    this.dispatch(event, args as unknown[]);
  }

  /**
   * Hot-path optimized emit for MessageRouted events.
   * Avoids rest/spread overhead of the generic `emit()`.
   */
  public emitMessageRouted(subject: string, kind: MessageKind): void {
    this.dispatch(TransportEvent.MessageRouted, [subject, kind]);
  }

  /**
   * Check whether any listener (user hook or internal subscriber) is registered
   * for the given event. Used by routing hot path to elide the emit call when
   * no one is listening.
   */
  public hasHook(event: keyof TransportHooks): boolean {
    return this.hooks[event] !== undefined || (this.subscribers.get(event)?.length ?? 0) > 0;
  }

  private dispatch(event: keyof TransportHooks, args: unknown[]): void {
    const subs = this.subscribers.get(event);

    if (subs) {
      for (const sub of subs) {
        this.callHook(event, sub, ...args);
      }
    }

    const hook = this.hooks[event];

    if (hook) {
      this.callHook(event, hook as AnyTransportListener, ...args);
    }
  }

  private callHook(event: string, hook: AnyTransportListener, ...args: unknown[]): void {
    try {
      const result = hook(...args);

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
