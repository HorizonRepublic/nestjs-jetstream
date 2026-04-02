import { Logger } from '@nestjs/common';

import { ConnectionProvider } from '../connection';
import { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';

/** Minimal interface for anything that can be stopped during shutdown. */
export interface Stoppable {
  close(): void;
}

/** Async callback invoked before the NATS connection is drained. */
export type PreDrainHook = () => Promise<void>;

/**
 * Orchestrates graceful transport shutdown.
 *
 * Shutdown sequence:
 * 1. Emit onShutdownStart hook
 * 2. Stop accepting new messages (close subscriptions, stop consumers)
 * 3. Execute pre-drain hooks (e.g. KV metadata cleanup)
 * 4. Drain and close NATS connection (with timeout safety net)
 * 5. Emit onShutdownComplete hook
 *
 * Idempotent — concurrent or repeated calls return the same promise.
 * This is critical because NestJS may call `onApplicationShutdown` on
 * multiple module instances (forRoot + forFeature) that share this
 * singleton, and the call order is not guaranteed.
 */
export class ShutdownManager {
  private readonly logger = new Logger('Jetstream:Shutdown');
  private readonly preDrainHooks: PreDrainHook[] = [];
  private shutdownPromise?: Promise<void>;

  public constructor(
    private readonly connection: ConnectionProvider,
    private readonly eventBus: EventBus,
    private readonly timeout: number,
  ) {}

  /**
   * Register a hook that runs before the NATS connection is drained.
   *
   * Use this for cleanup that requires an active connection (e.g. KV deletes).
   * Hooks are executed sequentially in registration order.
   * Errors in hooks are logged but do not prevent shutdown.
   */
  public registerPreDrainHook(hook: PreDrainHook): void {
    this.preDrainHooks.push(hook);
  }

  /**
   * Execute the full shutdown sequence.
   *
   * Idempotent — concurrent or repeated calls return the same promise.
   *
   * @param strategy Optional stoppable to close (stops consumers and subscriptions).
   */
  public async shutdown(strategy?: Stoppable): Promise<void> {
    this.shutdownPromise ??= this.doShutdown(strategy);

    return this.shutdownPromise;
  }

  private async doShutdown(strategy?: Stoppable): Promise<void> {
    this.eventBus.emit(TransportEvent.ShutdownStart);
    this.logger.log(`Graceful shutdown started (timeout: ${this.timeout}ms)`);

    // 1. Stop accepting new messages (close subscriptions, stop consumers)
    strategy?.close();

    // 2. Execute pre-drain hooks while the connection is still active
    for (const hook of this.preDrainHooks) {
      try {
        await hook();
      } catch (err) {
        this.logger.error('Pre-drain hook failed', err);
      }
    }

    // 3. Drain and close NATS connection.
    //    NATS drain() waits for in-flight messages and pending subscriptions,
    //    then closes the connection. We add a timeout as a safety net.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        this.connection.shutdown(),
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, this.timeout);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    this.eventBus.emit(TransportEvent.ShutdownComplete);
    this.logger.log('Graceful shutdown complete');
  }
}
