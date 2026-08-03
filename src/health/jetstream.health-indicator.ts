import { Injectable, Logger } from '@nestjs/common';

import type { ConnectionRegistry } from '../connection/connection-registry';
import type { ConnectionScope } from '../connection/connection.types';
import type { JetstreamConnectionHealth, JetstreamHealthStatus } from '../interfaces';

/**
 * Health indicator result compatible with @nestjs/terminus.
 *
 * Follows the Terminus convention: returns status object on success,
 * throws on failure. Works with Terminus out of the box, no wrapper needed:
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

  public constructor(private readonly registry: ConnectionRegistry) {}

  /**
   * Plain health status check.
   *
   * Returns the current connection status without throwing. `connected` means
   * every critical connection is alive; `degraded` means at least one
   * non-critical connection is not. With a single connection the
   * multi-connection fields are omitted entirely, so the response shape is
   * unchanged from before named connections existed.
   *
   * @returns Connection status with server URL and RTT latency.
   */
  public async check(): Promise<JetstreamHealthStatus> {
    const entries = await Promise.all(
      this.registry.all().map(async (scope) => [scope.name, await this.probe(scope)] as const),
    );

    const fallback: JetstreamConnectionHealth = {
      connected: false,
      critical: true,
      server: null,
      latency: null,
    };
    const defaultHealth =
      entries.find(([name]) => name === this.registry.defaultName)?.[1] ?? fallback;

    if (entries.length === 1) {
      return {
        connected: defaultHealth.connected,
        server: defaultHealth.server,
        latency: defaultHealth.latency,
      };
    }

    return {
      connected: entries.every(([, health]) => !health.critical || health.connected),
      server: defaultHealth.server,
      latency: defaultHealth.latency,
      degraded: entries.some(([, health]) => !health.critical && !health.connected),
      connections: Object.fromEntries(entries),
    };
  }

  private async probe(scope: ConnectionScope): Promise<JetstreamConnectionHealth> {
    const nc = scope.connection.unwrap;

    if (!nc || nc.isClosed()) {
      return { connected: false, critical: scope.critical, server: null, latency: null };
    }

    try {
      const start = performance.now();

      await nc.rtt();

      const latency = Math.round(performance.now() - start);

      return { connected: true, critical: scope.critical, server: nc.getServer(), latency };
    } catch (err) {
      this.logger.warn(
        `Health check failed for "${scope.name}": ${err instanceof Error ? err.message : String(err)}`,
      );

      return { connected: false, critical: scope.critical, server: nc.getServer(), latency: null };
    }
  }

  /**
   * Terminus-compatible health check.
   *
   * Returns `{ [key]: { status: 'up', ... } }` on success.
   * Throws an error with `{ [key]: { status: 'down', ... } }` on failure.
   *
   * Throws only when a critical connection is down, so a dead secondary cluster
   * degrades the report without failing readiness.
   *
   * The thrown error sets `isHealthCheckError: true` and `causes`, the
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

    if (status.degraded !== undefined) details.degraded = status.degraded;
    if (status.connections !== undefined) details.connections = status.connections;

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
