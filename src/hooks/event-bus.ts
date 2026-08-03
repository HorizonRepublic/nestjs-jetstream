import { Logger } from '@nestjs/common';

import type { MessageKind, TransportEventSubscriber, TransportHooks } from '../interfaces';
import { TransportEvent } from '../interfaces';
import type { TransportListener, TransportSubscriberRegistry } from './hooks.types';

/**
 * Central event bus for transport lifecycle notifications.
 *
 * Emission paths:
 *  - User hooks registered via `forRoot({ hooks })`: at most one per event.
 *  - Internal subscribers added via `subscribe()`: many per event, used by
 *    metrics and other built-in observers.
 *
 * Both fire on every `emit()` call. Subscriber failures are isolated and
 * logged; they do not block other subscribers or the user hook.
 */
export class EventBus {
  private readonly hooks: Partial<TransportHooks>;
  private readonly logger: Logger;
  private readonly subscribers: TransportSubscriberRegistry;
  private readonly connectionName: string | null;

  public constructor(
    logger: Logger,
    hooks?: Partial<TransportHooks> | undefined,
    connectionName?: string | undefined,
    subscribers?: TransportSubscriberRegistry | undefined,
  ) {
    this.logger = logger;
    this.hooks = hooks ?? {};
    this.connectionName = connectionName ?? null;
    this.subscribers = subscribers ?? new Map();
  }

  /**
   * A view of this bus that tags every emission with a connection name.
   *
   * Hooks and the subscriber registry are shared with the parent by reference,
   * so a subscriber registered after the view was created still fires through it.
   *
   * @param name Connection name appended as the trailing hook argument.
   */
  public forConnection(name: string): EventBus {
    return new EventBus(this.logger, this.hooks, name, this.subscribers);
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

    list.push(handler as TransportListener);
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
    // The root bus allocates nothing: a single-connection application never
    // creates a view, so its hot path is unchanged.
    const payload = this.connectionName === null ? args : [...args, this.connectionName];

    const subs = this.subscribers.get(event);

    if (subs?.length) {
      // Snapshot the array so a subscriber that re-subscribes to the same
      // event during dispatch cannot extend the live iteration.
      // oxlint-disable-next-line unicorn/no-useless-spread
      for (const sub of [...subs]) {
        this.callHook(event, sub, ...payload);
      }
    }

    const hook = this.hooks[event];

    if (hook) {
      this.callHook(event, hook as TransportListener, ...payload);
    }
  }

  private callHook(event: string, hook: TransportListener, ...args: unknown[]): void {
    try {
      const result = hook(...args);

      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch((err: unknown) => {
          this.logger.error(
            `Async hook "${event}" rejected: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } catch (err) {
      this.logger.error(
        `Hook "${event}" threw an error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
