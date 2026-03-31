import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mocked,
  type MockedFunction,
} from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { NatsConnection, Status } from '@nats-io/transport-node';
import { connect } from '@nats-io/transport-node';
import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';

import { EventBus } from '../hooks';
import type { JetstreamModuleOptions } from '../interfaces';
import { TransportEvent } from '../interfaces';

import { ConnectionProvider } from './connection.provider';

vi.mock('@nats-io/transport-node', async () => ({
  ...(await vi.importActual('@nats-io/transport-node')),
  connect: vi.fn(),
}));

vi.mock('@nats-io/jetstream', async () => ({
  ...(await vi.importActual('@nats-io/jetstream')),
  jetstream: vi.fn(),
  jetstreamManager: vi.fn(),
}));

const mockConnect = connect as MockedFunction<typeof connect>;

describe(ConnectionProvider, () => {
  let sut: ConnectionProvider;

  let eventBus: Mocked<EventBus>;
  let options: JetstreamModuleOptions;
  let mockNc: Mocked<NatsConnection>;

  const emptyStatusStream = (): AsyncIterable<Status> =>
    (async function* (): AsyncGenerator<Status> {})();

  const mockJetstream = jetstream as MockedFunction<typeof jetstream>;
  const mockJetstreamManager = jetstreamManager as MockedFunction<typeof jetstreamManager>;

  const createNc = (overrides?: Partial<Mocked<NatsConnection>>): Mocked<NatsConnection> =>
    createMock<NatsConnection>({
      isClosed: vi.fn().mockReturnValue(false),
      getServer: vi.fn().mockReturnValue('nats://localhost:4222'),
      status: vi.fn().mockReturnValue(emptyStatusStream()),
      drain: vi.fn().mockResolvedValue(undefined),
      closed: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    });

  beforeEach(() => {
    options = {
      name: faker.lorem.word(),
      servers: ['nats://localhost:4222'],
    };

    eventBus = createMock<EventBus>();
    mockNc = createNc();
    mockConnect.mockResolvedValue(mockNc);
    mockJetstream.mockReturnValue(createMock<JetStreamClient>());

    sut = new ConnectionProvider(options, eventBus);
  });

  afterEach(vi.resetAllMocks);

  describe('getConnection()', () => {
    describe('happy path', () => {
      it('should establish and return connection', async () => {
        // When: connection requested
        const nc = await sut.getConnection();

        // Then: connection established with correct config
        expect(nc).toBe(mockNc);
        expect(mockConnect).toHaveBeenCalledWith(
          expect.objectContaining({
            servers: options.servers,
            name: `${options.name}__microservice`,
          }),
        );
      });

      it('should emit Connect event with server URL', async () => {
        // When: connection established
        await sut.getConnection();

        // Then: Connect event emitted
        expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.Connect, 'nats://localhost:4222');
      });

      it('should cache connection on subsequent calls', async () => {
        // When: called twice
        await sut.getConnection();
        await sut.getConnection();

        // Then: only one physical connection
        expect(mockConnect).toHaveBeenCalledTimes(1);
      });

      it('should deduplicate concurrent connection attempts', async () => {
        // When: two concurrent calls
        const [nc1, nc2] = await Promise.all([sut.getConnection(), sut.getConnection()]);

        // Then: same connection, single connect call
        expect(nc1).toBe(nc2);
        expect(mockConnect).toHaveBeenCalledTimes(1);
      });
    });

    describe('error paths', () => {
      it('should throw RuntimeException on CONNECTION_REFUSED', async () => {
        // Given: connection refused
        mockConnect.mockRejectedValue(new Error('CONNECTION_REFUSED'));

        // When/Then: throws RuntimeException with server list
        await expect(sut.getConnection()).rejects.toThrow('NATS connection refused');
      });

      it('should re-throw non-connection errors', async () => {
        // Given: unexpected error
        mockConnect.mockRejectedValue(new Error('dns resolution failed'));

        // When/Then: error propagated
        await expect(sut.getConnection()).rejects.toThrow('dns resolution failed');
      });

      it('should allow retry after connection failure', async () => {
        // Given: first connection attempt fails, second succeeds
        mockConnect
          .mockRejectedValueOnce(new Error('Connection refused'))
          .mockResolvedValueOnce(mockNc);

        // When: first call fails
        await expect(sut.getConnection()).rejects.toThrow('Connection refused');

        // Then: second call should succeed (not return cached rejection)
        const result = await sut.getConnection();

        expect(result).toBe(mockNc);
      });
    });
  });

  describe('getJetStreamManager()', () => {
    describe('happy path', () => {
      it('should return JetStream manager', async () => {
        // Given: jsm available
        const mockJsm = createMock<JetStreamManager>();

        mockJetstreamManager.mockResolvedValue(mockJsm);

        // When: requested
        const jsm = await sut.getJetStreamManager();

        // Then: manager returned
        expect(jsm).toBe(mockJsm);
      });

      it('should cache JetStream manager on subsequent calls', async () => {
        // Given: jsm available
        const mockJsm = createMock<JetStreamManager>();

        mockJetstreamManager.mockResolvedValue(mockJsm);

        // When: called twice
        await sut.getJetStreamManager();
        await sut.getJetStreamManager();

        // Then: only one jsm created
        expect(mockJetstreamManager).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('unwrap', () => {
    it('should return null before connection is established', () => {
      expect(sut.unwrap).toBeNull();
    });

    it('should return the NatsConnection after getConnection()', async () => {
      // When: connected
      await sut.getConnection();

      // Then: raw connection accessible
      expect(sut.unwrap).toBe(mockNc);
    });
  });

  describe('shutdown()', () => {
    describe('happy path', () => {
      it('should drain and wait for close', async () => {
        // Given: connected
        await sut.getConnection();

        // When: shutdown
        await sut.shutdown();

        // Then: drain + close called
        expect(mockNc.drain).toHaveBeenCalled();
        expect(mockNc.closed).toHaveBeenCalled();
      });

      it('should null out connection after shutdown', async () => {
        // Given: connected
        await sut.getConnection();

        // When: shutdown
        await sut.shutdown();

        // Then: connection cleared
        expect(sut.unwrap).toBeNull();
      });
    });

    describe('edge cases', () => {
      it('should no-op when not connected', async () => {
        // When: shutdown without connection
        await sut.shutdown();

        // Then: no drain attempt
        expect(mockNc.drain).not.toHaveBeenCalled();
      });

      it('should no-op when connection is already closed', async () => {
        // Given: connected then closed externally
        await sut.getConnection();
        mockNc.isClosed.mockReturnValue(true);

        // When: shutdown
        await sut.shutdown();

        // Then: no drain attempt
        expect(mockNc.drain).not.toHaveBeenCalled();
      });
    });

    describe('error paths', () => {
      it('should force-close when drain throws', async () => {
        // Given: connected, drain will fail
        mockNc.drain.mockRejectedValue(new Error('drain error'));
        mockNc.close.mockResolvedValue(undefined);
        await sut.getConnection();

        // When: shutdown
        await sut.shutdown();

        // Then: force-close used, connection cleaned up
        expect(mockNc.close).toHaveBeenCalled();
        expect(sut.unwrap).toBeNull();
      });

      it('should still clean up when both drain and close throw', async () => {
        // Given: connected, both drain and close fail
        mockNc.drain.mockRejectedValue(new Error('drain error'));
        mockNc.close.mockRejectedValue(new Error('close error'));
        await sut.getConnection();

        // When: shutdown
        await sut.shutdown();

        // Then: connection still cleaned up
        expect(sut.unwrap).toBeNull();
      });
    });
  });

  describe('status monitoring', () => {
    it('should emit Disconnect event when server disconnects', async () => {
      // Given: status stream will yield Disconnect
      const nc = createNc({
        status: vi.fn().mockReturnValue(
          (async function* (): AsyncGenerator<Status> {
            yield { type: 'disconnect', data: '' } as Status;
          })(),
        ),
      });

      mockConnect.mockResolvedValue(nc);

      // When: connection established
      await sut.getConnection();
      await new Promise(process.nextTick);

      // Then: Disconnect emitted
      expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.Disconnect);
    });

    it('should emit Reconnect event with server URL on reconnect', async () => {
      // Given: status stream will yield Reconnect
      const nc = createNc({
        status: vi.fn().mockReturnValue(
          (async function* (): AsyncGenerator<Status> {
            yield { type: 'reconnect', data: '' } as Status;
          })(),
        ),
      });

      mockConnect.mockResolvedValue(nc);

      // When: connection established
      await sut.getConnection();
      await new Promise(process.nextTick);

      // Then: Reconnect emitted
      expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.Reconnect, nc.getServer());
    });

    it('should emit Error event on connection error status', async () => {
      // Given: status stream will yield Error
      const nc = createNc({
        status: vi.fn().mockReturnValue(
          (async function* (): AsyncGenerator<Status> {
            yield { type: 'error', error: new Error('test error') } as unknown as Status;
          })(),
        ),
      });

      mockConnect.mockResolvedValue(nc);

      // When: connection established
      await sut.getConnection();
      await new Promise(process.nextTick);

      // Then: Error emitted
      expect(eventBus.emit).toHaveBeenCalledWith(
        TransportEvent.Error,
        expect.any(Error),
        'connection',
      );
    });
  });

  describe('performance connection defaults', () => {
    it('should connect with unlimited reconnect attempts by default', async () => {
      // When: connection established
      await sut.getConnection();

      // Then: default applied
      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ maxReconnectAttempts: -1 }),
      );
    });

    it('should connect with 1s reconnect wait by default', async () => {
      // When: connection established
      await sut.getConnection();

      // Then: default applied
      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ reconnectTimeWait: 1_000 }),
      );
    });

    it('should allow user connectionOptions to override performance defaults', async () => {
      // Given: user overrides maxReconnectAttempts
      options.connectionOptions = { maxReconnectAttempts: 50 };
      sut = new ConnectionProvider(options, eventBus);

      // When: connection established
      await sut.getConnection();

      // Then: user value wins
      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ maxReconnectAttempts: 50 }),
      );
    });
  });

  describe('getJetStreamClient()', () => {
    it('should return a cached JetStreamClient instance', async () => {
      // Given: connected
      await sut.getConnection();

      // When: called twice
      const js1 = sut.getJetStreamClient();
      const js2 = sut.getJetStreamClient();

      // Then: same instance, jetstream() called once
      expect(js1).toBe(js2);
      expect(mockJetstream).toHaveBeenCalledTimes(1);
    });

    it('should throw if not connected', () => {
      // When/Then: throws before connection
      expect(() => sut.getJetStreamClient()).toThrow('Not connected');
    });

    it('should invalidate cached client on reconnect', async () => {
      // Given: connected, jetstream() returns different objects on each call.
      // Use a gate to delay the Reconnect event until after the first getJetStreamClient() call.
      let callCount = 0;

      mockJetstream.mockImplementation(() => {
        return { id: ++callCount } as unknown as JetStreamClient;
      });

      let emitReconnect!: () => void;
      const reconnectGate = new Promise<void>((resolve) => {
        emitReconnect = resolve;
      });

      const nc = createNc({
        status: vi.fn().mockReturnValue(
          (async function* (): AsyncGenerator<Status> {
            await reconnectGate;
            yield { type: 'reconnect', data: '' } as Status;
          })(),
        ),
      });

      mockConnect.mockResolvedValue(nc);
      sut = new ConnectionProvider(options, eventBus);
      await sut.getConnection();

      // When: get client before reconnect
      const js1 = sut.getJetStreamClient();

      expect(mockJetstream).toHaveBeenCalledTimes(1);

      // Trigger reconnect event and let it propagate
      emitReconnect();
      await new Promise(process.nextTick);

      // Then: cache was invalidated, new instance returned
      const js2 = sut.getJetStreamClient();

      expect(mockJetstream).toHaveBeenCalledTimes(2);
      expect(js1).not.toBe(js2);
    });
  });
});
