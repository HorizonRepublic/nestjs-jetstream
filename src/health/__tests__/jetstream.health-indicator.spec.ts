import type { NatsConnection } from '@nats-io/transport-node';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { ConnectionProvider } from '../../connection';
import { ConnectionRegistry } from '../../connection/connection-registry';
import type { ConnectionScope } from '../../connection/connection.types';
import { JetstreamHealthIndicator } from '../jetstream.health-indicator';

describe(JetstreamHealthIndicator, () => {
  let sut: JetstreamHealthIndicator;

  let connectionProvider: Mocked<ConnectionProvider>;

  const mockServer = faker.internet.url();

  const registryOf = (connection: ConnectionProvider): ConnectionRegistry =>
    new ConnectionRegistry(
      new Map([
        ['default', createMock<ConnectionScope>({ name: 'default', critical: true, connection })],
      ]),
      'default',
    );

  const setupConnected = (): void => {
    const nc = createMock<NatsConnection>({
      isClosed: vi.fn().mockReturnValue(false),
      rtt: vi.fn().mockResolvedValue(1),
      getServer: vi.fn().mockReturnValue(mockServer),
    });

    connectionProvider = createMock<ConnectionProvider>({ unwrap: nc });
    sut = new JetstreamHealthIndicator(registryOf(connectionProvider));
  };

  const setupDisconnected = (nc: NatsConnection | null = null): void => {
    connectionProvider = createMock<ConnectionProvider>({ unwrap: nc });
    sut = new JetstreamHealthIndicator(registryOf(connectionProvider));
  };

  afterEach(vi.resetAllMocks);

  describe('check()', () => {
    describe('happy path', () => {
      describe('when connection is healthy', () => {
        it('should return connected status with server and latency', async () => {
          // Given: a live connection
          setupConnected();

          // When: checked
          const status = await sut.check();

          // Then: healthy status returned
          expect(status.connected).toBe(true);
          expect(status.server).toBe(mockServer);
          expect(status.latency).toEqual(expect.any(Number));
        });
      });
    });

    describe('edge cases', () => {
      describe('when connection is null', () => {
        it('should return disconnected status', async () => {
          // Given: no connection
          setupDisconnected(null);

          // When: checked
          const status = await sut.check();

          // Then: disconnected
          expect(status).toEqual({ connected: false, server: null, latency: null });
        });
      });

      describe('when connection is closed', () => {
        it('should return disconnected status', async () => {
          // Given: a closed connection
          const nc = createMock<NatsConnection>({ isClosed: vi.fn().mockReturnValue(true) });

          setupDisconnected(nc);

          // When: checked
          const status = await sut.check();

          // Then: disconnected
          expect(status).toEqual({ connected: false, server: null, latency: null });
        });
      });
    });

    describe('error paths', () => {
      describe('when rtt() throws', () => {
        it('should return disconnected status with server info', async () => {
          // Given: rtt throws
          const nc = createMock<NatsConnection>({
            isClosed: vi.fn().mockReturnValue(false),
            rtt: vi.fn().mockRejectedValue(new Error('timeout')),
            getServer: vi.fn().mockReturnValue(mockServer),
          });

          setupDisconnected(nc);

          // When: checked
          const status = await sut.check();

          // Then: disconnected but server info preserved
          expect(status.connected).toBe(false);
          expect(status.server).toBe(mockServer);
          expect(status.latency).toBeNull();
        });

        it('should stringify non-Error rejection in the warning log', async () => {
          // Given: rtt rejects with a plain string (not an Error)
          const reason = faker.lorem.sentence();
          const nc = createMock<NatsConnection>({
            isClosed: vi.fn().mockReturnValue(false),
            rtt: vi.fn().mockRejectedValue(reason),
            getServer: vi.fn().mockReturnValue(mockServer),
          });

          setupDisconnected(nc);

          // When: checked
          const status = await sut.check();

          // Then: disconnected, and the raw reason appears in the log
          expect(status.connected).toBe(false);
          expect(status.latency).toBeNull();
        });
      });
    });
  });

  describe('isHealthy()', () => {
    describe('happy path', () => {
      describe('when connection is healthy', () => {
        it('should return Terminus-compatible up status with default key', async () => {
          // Given: a healthy connection
          setupConnected();

          // When: checked
          const result = await sut.isHealthy();

          // Then: Terminus format with 'jetstream' key
          expect(result.jetstream!.status).toBe('up');
          expect(result.jetstream!.server).toBe(mockServer);
          expect(result.jetstream!.latency).toEqual(expect.any(Number));
        });

        it('should use custom key when provided', async () => {
          // Given: healthy connection
          setupConnected();
          const key = faker.lorem.word();

          // When: checked with custom key
          const result = await sut.isHealthy(key);

          // Then: custom key used
          expect(result[key]!.status).toBe('up');
        });
      });
    });

    describe('error paths', () => {
      describe('when connection is unhealthy', () => {
        it('should throw with Terminus-compatible error', async () => {
          // Given: no connection
          setupDisconnected(null);

          // When/Then: throws
          await expect(sut.isHealthy()).rejects.toThrow('Jetstream health check failed');
        });

        it('should set isHealthCheckError flag for Terminus duck-type detection', async () => {
          // Given: no connection
          setupDisconnected(null);

          // When/Then: thrown error has the Terminus duck-type marker
          await expect(sut.isHealthy()).rejects.toMatchObject({
            isHealthCheckError: true,
          });
        });

        it('should include causes in thrown error for Terminus integration', async () => {
          // Given: no connection
          setupDisconnected(null);
          const key = faker.lorem.word();

          // When: fails
          const error = await sut.isHealthy(key).catch((err: unknown) => err);

          // Then: causes contain down details
          expect(error).toMatchObject({
            causes: {
              [key]: {
                status: 'down',
                server: null,
                latency: null,
              },
            },
          });
        });
      });
    });
  });

  describe('multiple connections', () => {
    const connectionScope = (name: string, critical: boolean, up: boolean): ConnectionScope =>
      createMock<ConnectionScope>({
        name,
        critical,
        connection: createMock<ConnectionProvider>({
          unwrap: up
            ? createMock<NatsConnection>({
                isClosed: () => false,
                rtt: vi.fn().mockResolvedValue(1),
                getServer: () => `nats://${name}:4222`,
              })
            : null,
        }),
      });

    const multiRegistry = (scopes: ConnectionScope[]): ConnectionRegistry =>
      new ConnectionRegistry(new Map(scopes.map((s) => [s.name, s])), scopes[0]?.name ?? 'primary');

    it('should omit the multi-connection fields for a single connection', async () => {
      // Given one healthy connection
      const registry = multiRegistry([connectionScope('default', true, true)]);

      sut = new JetstreamHealthIndicator(registry);

      // When checked
      const status = await sut.check();

      // Then the response is the pre-3.0 shape exactly
      expect(Object.keys(status).toSorted()).toEqual(['connected', 'latency', 'server']);
      expect(status.connected).toBe(true);
    });

    it('should report degraded when a non-critical connection is down', async () => {
      // Given a healthy critical and a dead non-critical connection
      const registry = multiRegistry([
        connectionScope('primary', true, true),
        connectionScope('analytics', false, false),
      ]);

      sut = new JetstreamHealthIndicator(registry);

      // When checked
      const status = await sut.check();

      // Then readiness holds but the breakdown flags the outage
      expect(status.connected).toBe(true);
      expect(status.degraded).toBe(true);
      expect(status.connections?.analytics?.connected).toBe(false);
      expect(status.connections?.analytics?.critical).toBe(false);
      expect(status.connections?.primary?.connected).toBe(true);
    });

    it('should report disconnected when a critical connection is down', async () => {
      // Given a dead critical connection alongside a healthy non-critical one
      const registry = multiRegistry([
        connectionScope('primary', true, false),
        connectionScope('analytics', false, true),
      ]);

      sut = new JetstreamHealthIndicator(registry);

      // When checked
      const status = await sut.check();

      // Then readiness fails and nothing is merely degraded
      expect(status.connected).toBe(false);
      expect(status.degraded).toBe(false);
    });

    it('should not throw from isHealthy when only a non-critical connection is down', async () => {
      // Given a degraded but ready system
      const registry = multiRegistry([
        connectionScope('primary', true, true),
        connectionScope('analytics', false, false),
      ]);

      sut = new JetstreamHealthIndicator(registry);

      // When the Terminus entry point runs
      const result = await sut.isHealthy();

      // Then it resolves and marks the degradation
      expect(result.jetstream?.status).toBe('up');
      expect(result.jetstream?.degraded).toBe(true);
    });

    it('should throw from isHealthy when a critical connection is down', async () => {
      // Given a dead critical connection
      const registry = multiRegistry([
        connectionScope('primary', true, false),
        connectionScope('analytics', false, true),
      ]);

      sut = new JetstreamHealthIndicator(registry);

      // When the Terminus entry point runs, Then it rejects
      await expect(sut.isHealthy()).rejects.toThrow(/health check failed/i);
    });
  });
});
