import { Logger } from '@nestjs/common';

import { ConnectionProvider } from '../connection';
import { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';

/** Minimal interface for anything that can be stopped during shutdown. */
export interface Stoppable {
  close(): void;
}

/**
 * Orchestrates graceful transport shutdown.
 *
 * Shutdown sequence:
 * 1. Emit onShutdownStart hook
 * 2. Stop accepting new messages (close subscriptions, stop consumers)
 * 3. Wait for in-flight handlers to complete (up to timeout)
 * 4. Drain and close NATS connection
 * 5. Emit onShutdownComplete hook
 */
export class ShutdownManager {
  private readonly logger = new Logger('Jetstream:Shutdown');

  public constructor(
    private readonly connection: ConnectionProvider,
    private readonly eventBus: EventBus,
    private readonly timeout: number,
  ) {}

  /**
   * Execute the full shutdown sequence.
   *
   * @param strategy Optional stoppable to close (stops consumers and subscriptions).
   */
  public async shutdown(strategy?: Stoppable): Promise<void> {
    this.eventBus.emit(TransportEvent.ShutdownStart);
    this.logger.log(`Graceful shutdown started (timeout: ${this.timeout}ms)`);

    // 1. Stop accepting new messages (close subscriptions, stop consumers)
    strategy?.close();

    // 2. Drain and close NATS connection.
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
