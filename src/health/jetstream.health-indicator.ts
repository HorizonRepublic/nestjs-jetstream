import { Injectable, Logger } from '@nestjs/common';

import type { ConnectionRegistry } from '../connection/connection-registry';
import type { ConnectionScope } from '../connection/connection.types';
import type {
  JetstreamConnectionHealth,
  JetstreamConsumerHealth,
  JetstreamConsumerState,
  JetstreamHealthCheckOptions,
  JetstreamHealthIndicatorResult,
  JetstreamHealthStatus,
} from '../interfaces';
import { STREAM_KIND_LABEL } from '../metrics/metrics.constants';
import type { ConsumerFlowState } from '../server/infrastructure/consumer-flow.types';
import { errorMessage } from '../utils';

/** Upper bound on a single connection's round-trip probe. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * How long a consume flow may stay down before it counts as unhealthy. Long
 * enough to ride out a NATS restart or a consumer recreated by self-healing,
 * whose retries back off up to 30 seconds, so readiness does not flap.
 */
const CONSUMER_STALL_THRESHOLD_MS = 30_000;

type ConsumptionHealth = Required<Pick<JetstreamConnectionHealth, 'consuming' | 'consumers'>>;

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
      const single: JetstreamHealthStatus = {
        connected: defaultHealth.connected,
        server: defaultHealth.server,
        latency: defaultHealth.latency,
      };

      if (defaultHealth.consuming !== undefined) {
        single.consuming = defaultHealth.consuming;
        single.consumers = defaultHealth.consumers;
        single.degraded = !defaultHealth.consuming;
      }

      return single;
    }

    const consumingEntries = entries.filter(([, health]) => health.consuming !== undefined);
    const status: JetstreamHealthStatus = {
      connected: entries.every(([, health]) => !health.critical || health.connected),
      server: defaultHealth.server,
      latency: defaultHealth.latency,
      degraded: entries.some(
        ([, health]) => (!health.critical && !health.connected) || health.consuming === false,
      ),
      connections: Object.fromEntries(entries),
    };

    if (consumingEntries.length > 0) {
      status.consuming = consumingEntries.every(
        ([, health]) => !health.critical || health.consuming === true,
      );
    }

    if (defaultHealth.consumers !== undefined) status.consumers = defaultHealth.consumers;

    return status;
  }

  private async probe(scope: ConnectionScope): Promise<JetstreamConnectionHealth> {
    const health = await this.probeConnection(scope);
    const consumption = this.consumption(scope);

    return consumption === null ? health : { ...health, ...consumption };
  }

  /** Consume-flow health, or `null` when this connection does not consume. */
  private consumption(scope: ConnectionScope): ConsumptionHealth | null {
    if (!scope.strategy?.isAttached || !scope.messages) return null;

    const now = Date.now();
    const consumers: Record<string, JetstreamConsumerHealth> = {};

    for (const flow of scope.messages.getFlowStates()) {
      consumers[STREAM_KIND_LABEL[flow.kind]] = this.describeFlow(flow, now);
    }

    return {
      // Before the boot chain finishes nothing consumes: it is still
      // provisioning, waiting on a migration, or retrying in the background.
      consuming:
        scope.strategy.isListening && Object.values(consumers).every((flow) => flow.healthy),
      consumers,
    };
  }

  private describeFlow(flow: ConsumerFlowState, now: number): JetstreamConsumerHealth {
    const downForMs = flow.downSince === null ? null : now - flow.downSince;

    return {
      healthy: downForMs === null || downForMs < CONSUMER_STALL_THRESHOLD_MS,
      state: this.flowState(flow),
      consumer: flow.consumer,
      failures: flow.failures,
      downForMs,
      lastError: flow.lastError,
    };
  }

  private flowState(flow: ConsumerFlowState): JetstreamConsumerState {
    if (flow.active) return 'active';

    return flow.connectedOnce ? 'recovering' : 'starting';
  }

  private async probeConnection(scope: ConnectionScope): Promise<JetstreamConnectionHealth> {
    const nc = scope.connection.unwrap;

    // A re-dialled connection serves clients, but the server side stayed on the closed one.
    if (!nc || nc.isClosed() || scope.connection.hasLostServerConnection()) {
      return { connected: false, critical: scope.critical, server: null, latency: null };
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const start = performance.now();

      // A stalled rtt() would otherwise hold the whole check open, and with it
      // the readiness probe that called it.
      await Promise.race([
        nc.rtt(),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`rtt did not answer within ${PROBE_TIMEOUT_MS}ms`));
          }, PROBE_TIMEOUT_MS);
        }),
      ]);

      const latency = Math.round(performance.now() - start);

      return { connected: true, critical: scope.critical, server: nc.getServer(), latency };
    } catch (err) {
      this.logger.warn(`Health check failed for "${scope.name}": ${errorMessage(err)}`);

      return { connected: false, critical: scope.critical, server: nc.getServer(), latency: null };
    } finally {
      clearTimeout(timeoutId);
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
   * Stalled consumers only mark the result `degraded` unless
   * `options.requireConsumers` is set: their usual causes (a missing stream or
   * consumer, another pod's migration) hit every replica at once, so failing
   * on them by default would take the whole fleet out of rotation.
   *
   * @param key - Health indicator key (default: `'jetstream'`).
   * @param options - Set `requireConsumers` to also fail while a critical
   *   connection is not consuming. Use it for readiness only, never liveness.
   * @returns Object with status, server, and latency under the given key.
   * @throws Error with `isHealthCheckError`, `causes`, and `{ [key]: { status: 'down' } }`.
   */
  public async isHealthy(
    key = 'jetstream',
    options: JetstreamHealthCheckOptions = {},
  ): Promise<JetstreamHealthIndicatorResult> {
    const status = await this.check();

    const healthy =
      status.connected && (options.requireConsumers !== true || status.consuming !== false);
    const details: Record<string, unknown> = {
      status: healthy ? 'up' : 'down',
      server: status.server,
      latency: status.latency,
    };

    if (status.consuming !== undefined) details.consuming = status.consuming;
    if (status.consumers !== undefined) details.consumers = status.consumers;
    if (status.degraded !== undefined) details.degraded = status.degraded;
    if (status.connections !== undefined) details.connections = status.connections;

    if (!healthy) {
      const causes = { [key]: details };

      throw Object.assign(new Error('Jetstream health check failed'), {
        causes,
        isHealthCheckError: true,
      });
    }

    return { [key]: details };
  }
}
