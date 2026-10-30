import { Logger } from '@nestjs/common';

import type { ConnectionRegistry } from '../connection/connection-registry';
import type { ConnectionScope } from '../connection/connection.types';
import { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';
import { errorMessage } from '../utils';
import type { Stoppable } from './shutdown.types';

const IDLE = Symbol('idle');
const DRAINED = Symbol('drained');
const TIMED_OUT = Symbol('timed-out');

/**
 * Most of the budget a drain is guaranteed when handlers outlast theirs. A
 * drain flushes buffered publishes and waits one server round trip, so a
 * healthy connection needs milliseconds; two seconds covers a slow or distant
 * cluster without taking much from handlers under a typical budget.
 */
const DRAIN_RESERVE_MAX_MS = 2_000;

/** A timer that resolves to {@link TIMED_OUT}, cancelled once its step is over. */
interface Deadline {
  readonly reached: Promise<typeof TIMED_OUT>;
  cancel(): void;
}

const startDeadline = (ms: number): Deadline => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<typeof TIMED_OUT>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(TIMED_OUT);
    }, ms);
  });

  return {
    reached,
    cancel: () => {
      clearTimeout(timeoutId);
    },
  };
};

/**
 * Orchestrates graceful transport shutdown across every connection.
 *
 * Shutdown sequence:
 * 1. Emit onShutdownStart hook
 * 2. Phase one: every connection stops accepting new messages
 * 3. Phase two, per connection and in parallel: wait for handlers already
 *    running to settle and reply, then drain. Both steps share the
 *    connection's budget, so the ceiling is `max(timeouts)` rather than their sum
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
    // A strategy that throws here must not abort the loop: the remaining
    // connections would never close, never drain, and the shared shutdown
    // promise would stay rejected for every later caller.
    for (const scope of scopes) {
      const strategy: Stoppable | null = scope.strategy;

      try {
        strategy?.close();
      } catch (err) {
        this.logger.warn(
          `Connection "${scope.name}" failed to stop accepting messages: ${errorMessage(err)}`,
        );
      }
    }

    // Phase 2: settle in-flight work, then drain, in parallel. allSettled rather
    // than all, so a connection that throws cannot stop the others from closing.
    await Promise.allSettled(scopes.map(async (scope) => this.drainScope(scope)));

    this.eventBus.emit(TransportEvent.ShutdownComplete);
    this.logger.log('Graceful shutdown complete');
  }

  /**
   * Let one connection's in-flight handlers finish, then drain it, all within
   * its own budget.
   *
   * Handlers settle first: on a drained connection their acks and replies are
   * lost, so events run again elsewhere and JetStream RPC callers time out.
   * Handlers get the budget minus a reserve, so the drain that flushes what
   * they published always gets time to run. A drain still running when the
   * whole budget is spent is cut by closing the connection.
   */
  private async drainScope(scope: ConnectionScope): Promise<void> {
    const budget = scope.options.shutdownTimeout ?? this.timeout;
    const handlerBudget = budget - Math.min(budget / 2, DRAIN_RESERVE_MAX_MS);
    const handlersDeadline = startDeadline(handlerBudget);
    const drainDeadline = startDeadline(budget);

    try {
      // Each race resolves to a marker rather than setting a flag, so which side
      // won is visible to the type checker as well as to us.
      const settled = await Promise.race([
        this.settleInFlight(scope.name, scope.strategy).then(() => IDLE),
        handlersDeadline.reached,
      ]);

      if (settled === TIMED_OUT) {
        this.logger.warn(
          `Connection "${scope.name}" still had handlers running after ${handlerBudget}ms; draining anyway`,
        );
      }

      const drained = await Promise.race([
        scope.connection.shutdown().then(() => DRAINED),
        drainDeadline.reached,
      ]);

      if (drained === TIMED_OUT) {
        this.logger.warn(`Connection "${scope.name}" did not drain within ${budget}ms; closing it`);
        await scope.connection.forceClose();
      }
    } catch (err) {
      this.logger.warn(`Connection "${scope.name}" failed to drain: ${errorMessage(err)}`);
    } finally {
      handlersDeadline.cancel();
      drainDeadline.cancel();
    }
  }

  /** Wait for the strategy's in-flight handlers; a failure here must not block the drain. */
  private async settleInFlight(name: string, strategy: Stoppable | null): Promise<void> {
    if (!strategy) return;

    try {
      await strategy.whenIdle();
    } catch (err) {
      this.logger.warn(
        `Connection "${name}" failed to wait for in-flight handlers: ${errorMessage(err)}`,
      );
    }
  }
}
