import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection, Status } from '@nats-io/transport-node';
import { connect } from '@nats-io/transport-node';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
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

import { ConnectionErrorReason } from '../../errors';
import { EventBus } from '../../hooks';
import type { JetstreamModuleOptions } from '../../interfaces';
import { TransportEvent } from '../../interfaces';
import { ConnectionProvider } from '../connection.provider';

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

  describe('getCapabilities()', () => {
    const jsmWithLevel = (level: number): Mocked<JetStreamManager> =>
      createMock<JetStreamManager>({
        getAccountInfo: vi.fn().mockResolvedValue({ api: { level } }),
      });

    it('should probe the API level once and reuse it', async () => {
      // Given
      const jsm = jsmWithLevel(5);

      mockJetstreamManager.mockResolvedValue(jsm);

      // When
      const first = await sut.getCapabilities();
      const second = await sut.getCapabilities();

      // Then
      expect(first.apiLevel).toBe(5);
      expect(second).toBe(first);
      expect(jsm.getAccountInfo).toHaveBeenCalledTimes(1);
    });

    it('should probe again after a reconnect, which may land on another server', async () => {
      // Given a connection whose status stream reconnects on demand
      let emitReconnect!: () => void;
      const reconnectGate = new Promise<void>((resolve) => {
        emitReconnect = resolve;
      });

      mockConnect.mockResolvedValue(
        createNc({
          status: vi.fn().mockReturnValue(
            (async function* (): AsyncGenerator<Status> {
              await reconnectGate;
              yield { type: 'reconnect', server: '' } as Status;
            })(),
          ),
        }),
      );
      mockJetstreamManager
        .mockResolvedValueOnce(jsmWithLevel(3))
        .mockResolvedValueOnce(jsmWithLevel(5));
      sut = new ConnectionProvider(options, eventBus);

      const before = await sut.getCapabilities();

      // When
      emitReconnect();
      await new Promise((resolve) => setImmediate(resolve));

      // Then
      expect(before.apiLevel).toBe(3);
      expect((await sut.getCapabilities()).apiLevel).toBe(5);
    });
  });

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
        await expect(sut.getConnection()).rejects.toThrow(
          expect.objectContaining({
            name: 'JetstreamConnectionError',
            reason: ConnectionErrorReason.Refused,
            message: expect.stringContaining('NATS connection refused'),
          }),
        );
      });

      it('should type the refusal nats.js reports', async () => {
        // Given: the error nats.js raises for ECONNREFUSED
        const refusal = new Error('connection refused');

        mockConnect.mockRejectedValue(refusal);

        // When/Then
        await expect(sut.getConnection()).rejects.toThrow(
          expect.objectContaining({
            name: 'JetstreamConnectionError',
            reason: ConnectionErrorReason.Refused,
            cause: refusal,
          }),
        );
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
          .mockRejectedValueOnce(new Error('connection refused'))
          .mockResolvedValueOnce(mockNc);

        // When: first call fails
        await expect(sut.getConnection()).rejects.toThrow('NATS connection refused');

        // Then: second call should succeed (not return cached rejection)
        const result = await sut.getConnection();

        expect(result).toBe(mockNc);
      });

      it('should refuse to dial again once shutdown finished', async () => {
        // Given: a connection that was shut down
        await sut.getConnection();
        await sut.shutdown();

        // When/Then: a late caller is rejected instead of opening a connection nothing closes
        await expect(sut.getConnection()).rejects.toThrow(
          expect.objectContaining({
            name: 'JetstreamConnectionError',
            reason: ConnectionErrorReason.ShuttingDown,
          }),
        );
        expect(mockConnect).toHaveBeenCalledOnce();
      });

      it('should refuse callers while the connection is draining', async () => {
        // Given: a drain that is still running
        mockNc.drain.mockReturnValue(new Promise<void>(() => {}));
        await sut.getConnection();
        void sut.shutdown();
        await new Promise(process.nextTick);

        // When/Then
        await expect(sut.getConnection()).rejects.toThrow(
          expect.objectContaining({ reason: ConnectionErrorReason.ShuttingDown }),
        );
      });

      it('should stay shut down when a dial in flight lands during shutdown', async () => {
        // Given: a dial that resolves only after shutdown started
        const { promise: dialed, resolve: finishDial } = Promise.withResolvers<NatsConnection>();

        mockConnect.mockReturnValueOnce(dialed);
        const first = sut.getConnection();
        const stopping = sut.shutdown();

        // When: the dial completes and shutdown drains it
        finishDial(mockNc);
        await first;
        await stopping;

        // Then: the drained connection is not replaced by a new one
        await expect(sut.getConnection()).rejects.toThrow(
          expect.objectContaining({ reason: ConnectionErrorReason.ShuttingDown }),
        );
        expect(mockNc.drain).toHaveBeenCalledOnce();
        expect(mockConnect).toHaveBeenCalledOnce();
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

  describe('forceClose()', () => {
    it('should close a connection whose drain is still running', async () => {
      // Given a drain that hangs
      mockNc.drain.mockReturnValue(new Promise<void>(() => {}));
      mockNc.close.mockResolvedValue(undefined);
      await sut.getConnection();
      void sut.shutdown();
      await new Promise(process.nextTick);

      // When the connection is force-closed
      await sut.forceClose();

      // Then the socket is closed without waiting for the drain
      expect(mockNc.close).toHaveBeenCalledOnce();
    });

    it('should no-op when not connected', async () => {
      // When
      await sut.forceClose();

      // Then
      expect(mockNc.close).not.toHaveBeenCalled();
    });

    it('should no-op when the connection is already closed', async () => {
      // Given
      await sut.getConnection();
      mockNc.isClosed.mockReturnValue(true);

      // When
      await sut.forceClose();

      // Then
      expect(mockNc.close).not.toHaveBeenCalled();
    });

    it('should swallow a failing close', async () => {
      // Given
      mockNc.close.mockRejectedValue(new Error(faker.lorem.sentence()));
      await sut.getConnection();

      // When / Then
      await expect(sut.forceClose()).resolves.toBeUndefined();
    });
  });

  describe('status monitoring', () => {
    it('should emit Disconnect event when server disconnects', async () => {
      // Given: status stream will yield Disconnect
      const nc = createNc({
        status: vi.fn().mockReturnValue(
          (async function* (): AsyncGenerator<Status> {
            yield { type: 'disconnect', server: '' } as Status;
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
            yield { type: 'reconnect', server: '' } as Status;
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
            yield { type: 'error', error: new Error('test error') };
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
      expect(() => sut.getJetStreamClient()).toThrow(
        expect.objectContaining({
          name: 'JetstreamConnectionError',
          reason: ConnectionErrorReason.NotConnected,
          message: expect.stringContaining('Not connected'),
        }),
      );
    });

    it('should invalidate cached client on reconnect', async () => {
      // Given: connected, jetstream() returns different objects on each call.
      // Use a gate to delay the Reconnect event until after the first getJetStreamClient() call.
      let callCount = 0;

      mockJetstream.mockImplementation(() => {
        return createMock<JetStreamClient>({ apiPrefix: String(++callCount) });
      });

      let emitReconnect!: () => void;
      const reconnectGate = new Promise<void>((resolve) => {
        emitReconnect = resolve;
      });

      const nc = createNc({
        status: vi.fn().mockReturnValue(
          (async function* (): AsyncGenerator<Status> {
            await reconnectGate;
            yield { type: 'reconnect', server: '' } as Status;
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

  describe('re-establishing after a terminal close', () => {
    interface ClosableConnection {
      nc: Mocked<NatsConnection>;
      close(): void;
    }

    /** Status feed that, like nats.js, hands every `status()` caller its own iterator. */
    interface StatusFeed {
      open(): AsyncIterable<Status>;
      emit(status: Status): void;
      end(): void;
    }

    type Wake = () => void;

    interface StatusListener {
      queue: Status[];
      wake: Wake | null;
      ended: boolean;
    }

    const statusFeed = (): StatusFeed => {
      const listeners: StatusListener[] = [];

      return {
        open: (): AsyncIterable<Status> => {
          const listener: StatusListener = { queue: [], wake: null, ended: false };

          listeners.push(listener);

          return (async function* (): AsyncGenerator<Status> {
            while (!listener.ended || listener.queue.length > 0) {
              const next = listener.queue.shift();

              if (next) {
                yield next;
                continue;
              }

              await new Promise<void>((resolve) => {
                listener.wake = resolve;
              });
            }
          })();
        },
        emit: (status): void => {
          for (const listener of listeners) {
            listener.queue.push(status);
            listener.wake?.();
          }
        },
        end: (): void => {
          for (const listener of listeners) {
            listener.ended = true;
            listener.wake?.();
          }
        },
      };
    };

    const closableConnection = (feed?: StatusFeed): ClosableConnection => {
      let closed = false;
      const nc = createNc({
        isClosed: vi.fn(() => closed),
        status: vi.fn(() => feed?.open() ?? emptyStatusStream()),
      });

      return {
        nc,
        close: (): void => {
          closed = true;
        },
      };
    };

    it('should bind the JetStream client to the new connection', async () => {
      // Given a client cached on a connection that then closed for good
      const first = closableConnection();
      const second = closableConnection();

      mockConnect.mockResolvedValueOnce(first.nc).mockResolvedValueOnce(second.nc);
      mockJetstream.mockImplementation(() => createMock<JetStreamClient>());
      await sut.getConnection();
      const stale = sut.getJetStreamClient();

      first.close();

      // When the connection is re-established
      await sut.getConnection();
      const fresh = sut.getJetStreamClient();

      // Then the client is rebuilt on the new connection
      expect(fresh).not.toBe(stale);
      expect(mockJetstream).toHaveBeenLastCalledWith(second.nc);
    });

    it('should bind the JetStream manager to the new connection', async () => {
      // Given a manager cached on a connection that then closed for good
      const first = closableConnection();
      const second = closableConnection();

      mockConnect.mockResolvedValueOnce(first.nc).mockResolvedValueOnce(second.nc);
      mockJetstreamManager.mockImplementation(async () => createMock<JetStreamManager>());
      const stale = await sut.getJetStreamManager();

      first.close();

      // When the connection is re-established
      await sut.getConnection();
      const fresh = await sut.getJetStreamManager();

      // Then the manager is rebuilt on the new connection
      expect(fresh).not.toBe(stale);
      expect(mockJetstreamManager).toHaveBeenLastCalledWith(second.nc);
    });

    it('should probe the capabilities of the new connection', async () => {
      // Given capabilities probed on a connection that then closed for good
      const first = closableConnection();
      const second = closableConnection();

      mockConnect.mockResolvedValueOnce(first.nc).mockResolvedValueOnce(second.nc);
      mockJetstreamManager
        .mockResolvedValueOnce(
          createMock<JetStreamManager>({
            getAccountInfo: vi.fn().mockResolvedValue({ api: { level: 3 } }),
          }),
        )
        .mockResolvedValueOnce(
          createMock<JetStreamManager>({
            getAccountInfo: vi.fn().mockResolvedValue({ api: { level: 5 } }),
          }),
        );
      expect((await sut.getCapabilities()).apiLevel).toBe(3);

      first.close();

      // When the connection is re-established
      await sut.getConnection();

      // Then the new server is probed
      expect((await sut.getCapabilities()).apiLevel).toBe(5);
    });

    it('should remember that a connection serving handlers closed for good', async () => {
      // Given a server bound to a connection
      const feed = statusFeed();
      const first = closableConnection(feed);
      const second = closableConnection();

      mockConnect.mockResolvedValueOnce(first.nc).mockResolvedValueOnce(second.nc);
      await sut.getConnection();
      sut.bindServer();

      // When that connection closes for good and a client call dials a new one
      first.close();
      feed.end();
      await vi.waitFor(() => {
        expect(sut.hasLostServerConnection()).toBe(true);
      });
      await sut.getConnection();

      // Then the loss sticks: the server side is still bound to the closed connection
      expect(sut.hasLostServerConnection()).toBe(true);
    });

    it('should not flag a terminal close when no server is bound', async () => {
      // Given a client-only connection
      const feed = statusFeed();
      const first = closableConnection(feed);

      mockConnect.mockResolvedValueOnce(first.nc);
      await sut.getConnection();

      // When it closes for good
      first.close();
      feed.end();
      await new Promise(process.nextTick);

      // Then re-dialling is enough to recover
      expect(sut.hasLostServerConnection()).toBe(false);
    });

    it('should not flag a deliberate shutdown', async () => {
      // Given a server bound to a connection that ends its status feed when drained
      const feed = statusFeed();
      const nc = createNc({
        status: vi.fn(() => feed.open()),
        drain: vi.fn(async () => {
          feed.end();
        }),
      });

      mockConnect.mockResolvedValueOnce(nc);
      await sut.getConnection();
      sut.bindServer();

      // When the application shuts down
      await sut.shutdown();
      await new Promise(process.nextTick);

      // Then the close is not treated as a loss
      expect(sut.hasLostServerConnection()).toBe(false);
    });

    it('should keep status$ subscribers on the new connection', async () => {
      // Given a status$ subscriber on a connection that then closes for good
      const firstStatus = statusFeed();
      const secondStatus = statusFeed();
      const first = closableConnection(firstStatus);
      const second = closableConnection(secondStatus);
      const seen: Status[] = [];

      mockConnect.mockResolvedValueOnce(first.nc).mockResolvedValueOnce(second.nc);
      const subscription = sut.status$.subscribe((status) => seen.push(status));

      await vi.waitFor(() => {
        expect(first.nc.status).toHaveBeenCalledTimes(2);
      });
      firstStatus.emit({ type: 'close' } as Status);
      firstStatus.end();
      first.close();
      await vi.waitFor(() => {
        expect(seen).toHaveLength(1);
      });

      // When the connection is re-established and its status changes
      await sut.getConnection();
      await vi.waitFor(() => {
        expect(second.nc.status).toHaveBeenCalledTimes(2);
      });
      secondStatus.emit({ type: 'disconnect', server: '' } as Status);

      // Then the existing subscriber sees the new connection's events
      await vi.waitFor(() => {
        expect(seen.map((s) => s.type)).toEqual(['close', 'disconnect']);
      });
      subscription.unsubscribe();
    });
  });
});
