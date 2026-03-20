import { Injectable, Logger } from '@nestjs/common';

import { ConnectionProvider } from '../connection';

/**
 * Health status returned by {@link JetstreamHealthIndicator.check}.
 */
export interface JetstreamHealthStatus {
  /** Whether the NATS connection is alive. */
  connected: boolean;
  /** NATS server URL, or `null` if not connected. */
  server: string | null;
  /** Round-trip latency in ms, or `null` if disconnected. */
  latency: number | null;
}

/**
 * Health indicator result compatible with @nestjs/terminus.
 *
 * Follows the Terminus convention: returns status object on success,
 * throws on failure. Works with Terminus out of the box — no wrapper needed:
 *
 * @example
 * ```typescript
 * // With Terminus
 * this.health.check([() => this.jetstream.isHealthy()])
 *
 * // Standalone
 * const status = await this.jetstream.check();
 * ```
 */
@Injectable()
export class JetstreamHealthIndicator {
  private readonly logger = new Logger('Jetstream:Health');

  public constructor(private readonly connection: ConnectionProvider) {}

  /**
   * Plain health status check.
   *
   * Returns the current connection status without throwing.
   * Use this for custom health endpoints or monitoring integrations.
   *
   * @returns Connection status with server URL and RTT latency.
   */
  public async check(): Promise<JetstreamHealthStatus> {
    const nc = this.connection.unwrap;

    if (!nc || nc.isClosed()) {
      return { connected: false, server: null, latency: null };
    }

    try {
      const start = performance.now();

      await nc.rtt();

      const latency = Math.round(performance.now() - start);

      return { connected: true, server: nc.getServer(), latency };
    } catch (err) {
      this.logger.warn(`Health check failed: ${err instanceof Error ? err.message : err}`);
      return { connected: false, server: nc.getServer(), latency: null };
    }
  }

  /**
   * Terminus-compatible health check.
   *
   * Returns `{ [key]: { status: 'up', ... } }` on success.
   * Throws an error with `{ [key]: { status: 'down', ... } }` on failure.
   *
   * @param key - Health indicator key (default: `'jetstream'`).
   * @returns Object with status, server, and latency under the given key.
   * @throws Error with `{ [key]: { status: 'down' } }` when disconnected.
   */
  public async isHealthy(key = 'jetstream'): Promise<Record<string, Record<string, unknown>>> {
    const status = await this.check();

    const details: Record<string, unknown> = {
      status: status.connected ? 'up' : 'down',
      server: status.server,
      latency: status.latency,
    };

    if (!status.connected) {
      throw Object.assign(new Error('Jetstream health check failed'), {
        [key]: details,
      });
    }

    return { [key]: details };
  }
}
