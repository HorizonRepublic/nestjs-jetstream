import { afterEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { NatsConnection } from 'nats';

import { ConnectionProvider } from '../connection';

import { JetstreamHealthIndicator } from './jetstream.health-indicator';

describe(JetstreamHealthIndicator, () => {
  let sut: JetstreamHealthIndicator;

  let connectionProvider: Mocked<ConnectionProvider>;

  const mockServer = faker.internet.url();

  const setupConnected = (): void => {
    const nc = createMock<NatsConnection>({
      isClosed: vi.fn().mockReturnValue(false),
      rtt: vi.fn().mockResolvedValue(1),
      getServer: vi.fn().mockReturnValue(mockServer),
    });

    connectionProvider = createMock<ConnectionProvider>({ unwrap: nc });
    sut = new JetstreamHealthIndicator(connectionProvider);
  };

  const setupDisconnected = (nc: NatsConnection | null = null): void => {
    connectionProvider = createMock<ConnectionProvider>({ unwrap: nc });
    sut = new JetstreamHealthIndicator(connectionProvider);
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

        it('should attach down details to the thrown error', async () => {
          // Given: no connection
          setupDisconnected(null);
          const key = faker.lorem.word();

          // When: fails — Then: details attached to error
          await expect(sut.isHealthy(key)).rejects.toMatchObject({
            [key]: {
              status: 'down',
              server: null,
              latency: null,
            },
          });
        });
      });
    });
  });
});
