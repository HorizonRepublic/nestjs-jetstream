import { Logger } from '@nestjs/common';

import type { ConnectionRegistry } from '../connection/connection-registry';
import type { ConnectionScope } from '../connection/connection.types';
import { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';

/** Minimal interface for anything that can be stopped during shutdown. */
export interface Stoppable {
  close(): void;
}

/**
 * Orchestrates graceful transport shutdown across every connection.
 *
 * Shutdown sequence:
 * 1. Emit onShutdownStart hook
 * 2. Phase one: every connection stops accepting new messages
 * 3. Phase two: every connection drains in parallel, each bounded by its own
 *    budget, so the ceiling is `max(timeouts)` rather than their sum
 * 4. Emit onShutdownComplete hook
 *
 * The phases are separate on purpose: draining connections one by one would let
 * a connection keep accepting work while its peers are already winding down.
 *
 * Idempotent: concurrent or repeated calls return the same promise.
 * This is critical because NestJS may call `onApplicationShutdown` on
 * multiple module instances (forRoot + forFeature) that share this
 * singleton, and the call order is not guaranteed.
 */
export class ShutdownManager {
  private readonly logger = new Logger('Jetstream:Shutdown');
  private shutdownPromise?: Promise<void>;

  public constructor(
    private readonly registry: ConnectionRegistry,
    private readonly eventBus: EventBus,
    private readonly timeout: number,
  ) {}

  /**
   * Execute the full shutdown sequence.
   *
   * Idempotent: concurrent or repeated calls return the same promise.
   */
  public async shutdown(): Promise<void> {
    this.shutdownPromise ??= this.doShutdown();

    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    this.eventBus.emit(TransportEvent.ShutdownStart);
    this.logger.log(`Graceful shutdown started (timeout: ${this.timeout}ms)`);

    const scopes = this.registry.all();

    // Phase 1: stop accepting new messages everywhere before anything drains.
    for (const scope of scopes) {
      scope.strategy?.close();
    }

    // Phase 2: drain in parallel. allSettled rather than all, so a connection
    // that throws while draining cannot stop the others from closing.
    await Promise.allSettled(scopes.map(async (scope) => this.drainScope(scope)));

    this.eventBus.emit(TransportEvent.ShutdownComplete);
    this.logger.log('Graceful shutdown complete');
  }

  /**
   * Drain one connection, bounded by its own budget.
   *
   * NATS `drain()` waits for in-flight messages and pending subscriptions, then
   * closes the connection; the timeout is a safety net for a drain that hangs.
   */
  private async drainScope(scope: ConnectionScope): Promise<void> {
    const budget = scope.options.shutdownTimeout ?? this.timeout;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        scope.connection.shutdown(),
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, budget);
        }),
      ]);
    } catch (err) {
      this.logger.warn(
        `Connection "${scope.name}" failed to drain: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
