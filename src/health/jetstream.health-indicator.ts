import { Injectable, Logger } from '@nestjs/common';

import { ConnectionProvider } from '../connection';
import type { JetstreamHealthStatus } from '../interfaces';

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
   * The thrown error sets `isHealthCheckError: true` and `causes` — the
   * duck-type contract that Terminus `HealthCheckExecutor` uses to distinguish
   * health failures from unexpected exceptions. Works with both Terminus v10
   * (`instanceof HealthCheckError`) and v11+ (`error?.isHealthCheckError`).
   *
   * @param key - Health indicator key (default: `'jetstream'`).
   * @returns Object with status, server, and latency under the given key.
   * @throws Error with `isHealthCheckError`, `causes`, and `{ [key]: { status: 'down' } }`.
   */
  public async isHealthy(key = 'jetstream'): Promise<Record<string, Record<string, unknown>>> {
    const status = await this.check();

    const details: Record<string, unknown> = {
      status: status.connected ? 'up' : 'down',
      server: status.server,
      latency: status.latency,
    };

    if (!status.connected) {
      const causes = { [key]: details };

      throw Object.assign(new Error('Jetstream health check failed'), {
        causes,
        isHealthCheckError: true,
      });
    }

    return { [key]: details };
  }
}
