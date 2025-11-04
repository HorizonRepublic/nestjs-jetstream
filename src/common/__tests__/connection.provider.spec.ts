import { NatsConnection, NatsError } from 'nats';
import { firstValueFrom, take, timeout } from 'rxjs';

import { ConnectionProvider } from '../connection.provider';
import type { IJetstreamTransportOptions } from '../types';
import { ServiceType } from '../enum/service-type.enum';

// Mock nats module
jest.mock('nats', () => ({
  connect: jest.fn(),
  // eslint-disable-next-line @typescript-eslint/naming-convention
  NatsError: class MockNatsError extends Error {
    public code: string;

    public constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { connect } from 'nats';

describe('ConnectionProvider', () => {
  let provider: ConnectionProvider;
  let mockConnection: Partial<NatsConnection>;
  let options: IJetstreamTransportOptions;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Setup mock connection
    mockConnection = {
      getServer: jest.fn().mockReturnValue('nats://localhost:4222'),
      isClosed: jest.fn().mockReturnValue(false),
      isDraining: jest.fn().mockReturnValue(false),
      close: jest.fn().mockResolvedValue(undefined),
      drain: jest.fn().mockResolvedValue(undefined),
      closed: jest.fn().mockResolvedValue(undefined),
      jetstreamManager: jest.fn().mockResolvedValue({
        streams: { list: jest.fn() },
      }),
      status: jest.fn().mockReturnValue(
        (async function* (): AsyncGenerator<{ type: string; data: string }> {
          yield { type: 'connect', data: 'connected' };
        })(),
      ),
    };

    options = {
      name: 'test-service',
      servers: ['localhost:4222'],
      serviceType: ServiceType.Producer,
    };

    (connect as jest.Mock).mockResolvedValue(mockConnection);
  });

  afterEach(async () => {
    if (provider) {
      try {
        provider.onModuleDestroy();
      } catch {
        // Ignore cleanup errors
      }
    }

    jest.resetAllMocks();
  });

  describe('constructor and setup', () => {
    it('should create provider instance', () => {
      provider = new ConnectionProvider(options);

      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(ConnectionProvider);
    });

    it('should setup connection on initialization', () => {
      provider = new ConnectionProvider(options);

      expect(provider.nc).toBeDefined();
      expect(provider.jsm).toBeDefined();
      expect(provider.status).toBeDefined();
    });
  });

  describe('nc (connection observable)', () => {
    it('should establish connection and return NatsConnection', async () => {
      provider = new ConnectionProvider(options);

      const connection = await firstValueFrom(provider.nc.pipe(take(1)));

      expect(connection).toBe(mockConnection);
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test-service_producer',
          servers: ['localhost:4222'],
        }),
      );
    });

    it('should cache connection for multiple subscribers', async () => {
      provider = new ConnectionProvider(options);

      const connection1 = await firstValueFrom(provider.nc.pipe(take(1)));
      const connection2 = await firstValueFrom(provider.nc.pipe(take(1)));

      expect(connection1).toBe(connection2);
      expect(connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('jsm (JetStream manager)', () => {
    it('should create JetStream manager from connection', async () => {
      provider = new ConnectionProvider(options);

      const jsm = await firstValueFrom(provider.jsm.pipe(take(1)));

      expect(jsm).toBeDefined();
      expect(mockConnection.jetstreamManager).toHaveBeenCalled();
    });

    it('should cache JetStream manager', async () => {
      provider = new ConnectionProvider(options);

      const jsm1 = await firstValueFrom(provider.jsm.pipe(take(1)));
      const jsm2 = await firstValueFrom(provider.jsm.pipe(take(1)));

      expect(jsm1).toBe(jsm2);
      expect(mockConnection.jetstreamManager).toHaveBeenCalledTimes(1);
    });
  });

  describe('status', () => {
    it('should return status observable', async () => {
      provider = new ConnectionProvider(options);

      const statusValue = await firstValueFrom(provider.status.pipe(take(1), timeout(1000)));

      expect(statusValue).toEqual({ type: 'connect', data: 'connected' });
    });
  });

  describe('unwrap', () => {
    it('should return raw connection instance', async () => {
      provider = new ConnectionProvider(options);

      // Trigger connection
      await firstValueFrom(provider.nc.pipe(take(1)));

      const unwrapped = provider.unwrap;

      expect(unwrapped).toBe(mockConnection);
    });
  });

  describe('gracefulShutdown', () => {
    it('should drain and close connection', async () => {
      provider = new ConnectionProvider(options);

      // Establish connection first
      await firstValueFrom(provider.nc.pipe(take(1)));

      await firstValueFrom(provider.gracefulShutdown().pipe(take(1)));

      expect(mockConnection.drain).toHaveBeenCalled();
      expect(mockConnection.closed).toHaveBeenCalled();
    });

    it('should force close if drain fails', async () => {
      (mockConnection.drain as jest.Mock).mockRejectedValue(new Error('Drain failed'));

      provider = new ConnectionProvider(options);
      await firstValueFrom(provider.nc.pipe(take(1)));

      await firstValueFrom(provider.gracefulShutdown().pipe(take(1)));

      expect(mockConnection.drain).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('should handle close errors gracefully', async () => {
      (mockConnection.drain as jest.Mock).mockRejectedValue(new Error('Drain failed'));
      (mockConnection.close as jest.Mock).mockRejectedValue(new Error('Close failed'));

      provider = new ConnectionProvider(options);
      await firstValueFrom(provider.nc.pipe(take(1)));

      const result = await firstValueFrom(provider.gracefulShutdown().pipe(take(1)));

      expect(result).toBeUndefined();
    });
  });

  describe('onModuleDestroy', () => {
    it('should cleanup subscription on module destroy', () => {
      provider = new ConnectionProvider(options);

      expect(() => {
        provider.onModuleDestroy();
      }).not.toThrow();
    });
  });

  describe('error handling', () => {
    it('should throw RuntimeException on CONNECTION_REFUSED error', async () => {
      const error = new NatsError('Connection refused', 'CONNECTION_REFUSED');

      (connect as jest.Mock).mockRejectedValue(error);

      provider = new ConnectionProvider(options);

      await expect(firstValueFrom(provider.nc.pipe(take(1)))).rejects.toThrow();
    });

    it('should handle other errors gracefully', async () => {
      const error = new Error('Some other error');

      (connect as jest.Mock).mockRejectedValue(error);

      provider = new ConnectionProvider(options);

      // Should handle error without throwing
      await expect(firstValueFrom(provider.nc.pipe(take(1), timeout(1000)))).rejects.toThrow();
    });
  });

  describe('connection name formatting', () => {
    it('should format connection name with service type', async () => {
      provider = new ConnectionProvider(options);

      await firstValueFrom(provider.nc.pipe(take(1)));

      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test-service_producer',
        }),
      );
    });

    it('should use consumer service type when specified', async () => {
      const serverOptions = {
        ...options,
        serviceType: ServiceType.Consumer,
      };

      provider = new ConnectionProvider(serverOptions);
      await firstValueFrom(provider.nc.pipe(take(1)));

      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test-service_consumer',
        }),
      );
    });
  });
});
