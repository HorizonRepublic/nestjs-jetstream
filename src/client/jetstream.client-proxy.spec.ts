import { JetstreamClientProxy } from './jetstream.client-proxy';
import { IClientProviders } from './types';
import { ConnectionProvider } from '../common/connection.provider';
import { JetstreamHeaders, JetStreamKind } from '../enum';
import { ReplaySubject } from 'rxjs';
import { JetStreamClient, Msg, NatsConnection, Subscription } from 'nats';

describe('JetstreamClientProxy', () => {
  let proxy: JetstreamClientProxy;
  let mockConnectionProvider: ConnectionProvider;
  let mockNatsConnection: NatsConnection;
  let mockJetStreamClient: JetStreamClient;
  let mockProviders: IClientProviders;
  let ncSubject: ReplaySubject<NatsConnection>;

  beforeEach(() => {
    ncSubject = new ReplaySubject<NatsConnection>(1);

    mockJetStreamClient = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as JetStreamClient;

    mockNatsConnection = {
      jetstream: jest.fn().mockReturnValue(mockJetStreamClient),
      subscribe: jest.fn().mockReturnValue({} as Subscription),
      close: jest.fn().mockResolvedValue(undefined),
      isClosed: jest.fn().mockReturnValue(false),
      isDraining: jest.fn().mockReturnValue(false),
      getServer: jest.fn().mockReturnValue('nats://localhost:4222'),
    } as unknown as NatsConnection;

    mockConnectionProvider = {
      nc: ncSubject.asObservable(),
      unwrap: mockNatsConnection,
    } as ConnectionProvider;

    mockProviders = {
      connectionProvider: mockConnectionProvider,
      options: {
        name: 'test-service',
        servers: ['localhost:4222'],
      },
    } as IClientProviders;

    proxy = new JetstreamClientProxy(mockProviders);
  });

  afterEach(() => {
    ncSubject.complete();
  });

  describe('onModuleInit', () => {
    it('should call connect on module initialization', () => {
      const connectSpy = jest.spyOn(proxy, 'connect').mockResolvedValue(mockNatsConnection);

      proxy.onModuleInit();

      expect(connectSpy).toHaveBeenCalled();
    });
  });

  describe('connect', () => {
    it('should establish connection and setup inbox subscription', async () => {
      ncSubject.next(mockNatsConnection);

      const result = await proxy.connect();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(result).toBe(mockNatsConnection);
      expect(mockNatsConnection.subscribe).toHaveBeenCalledWith(
        expect.stringContaining('test-service'),
        expect.objectContaining({ callback: expect.any(Function) }),
      );
    });

    it('should not setup inbox subscription twice', async () => {
      ncSubject.next(mockNatsConnection);

      const firstConnect = proxy.connect();

      await firstConnect;

      const secondConnect = proxy.connect();

      await secondConnect;

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockNatsConnection.subscribe).toHaveBeenCalledTimes(1);
    });

    it('should skip subscription if connection is closed', async () => {
      (mockNatsConnection.isClosed as jest.Mock).mockReturnValue(true);

      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockNatsConnection.subscribe).not.toHaveBeenCalled();
    });

    it('should skip subscription if connection is draining', async () => {
      (mockNatsConnection.isDraining as jest.Mock).mockReturnValue(true);

      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockNatsConnection.subscribe).not.toHaveBeenCalled();
    });

    it('should reset subscription flag on connection error', async () => {
      const errorSubject = new ReplaySubject<NatsConnection>(1);

      const errorMockProvider = {
        connectionProvider: {
          nc: errorSubject.asObservable(),
          unwrap: mockNatsConnection,
        } as ConnectionProvider,
        options: {
          name: 'test-service',
          servers: ['localhost:4222'],
        },
      } as IClientProviders;

      const errorProxy = new JetstreamClientProxy(errorMockProvider);

      errorSubject.next(mockNatsConnection);

      const connectPromise = errorProxy.connect();

      await connectPromise;

      errorSubject.error(new Error('Connection failed'));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(errorMockProvider.connectionProvider.nc).toBeTruthy();
    });
  });

  describe('dispatchEvent', () => {
    it('should publish event without waiting for acknowledgment', async () => {
      const packet = { pattern: 'user.created', data: { id: 1 } };

      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (proxy as any).dispatchEvent(packet);

      expect(result).toBeUndefined();
      expect(mockJetStreamClient.publish).toHaveBeenCalledWith(
        'test-service.ev.user.created',
        expect.any(Uint8Array),
        expect.objectContaining({ headers: expect.anything() }),
      );
    });

    it('should create correct subject for events', async () => {
      const packet = { pattern: 'order.placed', data: {} };

      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (proxy as any).dispatchEvent(packet);

      expect(mockJetStreamClient.publish).toHaveBeenCalledWith(
        'test-service.ev.order.placed',
        expect.any(Uint8Array),
        expect.anything(),
      );
    });
  });

  describe('publish', () => {
    it('should register callback and publish command', async () => {
      const packet = { pattern: 'user.get', data: { id: 1 } };
      const callback = jest.fn();

      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleanup = (proxy as any).publish(packet, callback);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockJetStreamClient.publish).toHaveBeenCalledWith(
        'test-service.cmd.user.get',
        expect.any(Uint8Array),
        expect.objectContaining({
          headers: expect.anything(),
        }),
      );
      expect(cleanup).toBeInstanceOf(Function);
    });

    it('should invoke callback with error on publish failure', async () => {
      const packet = { pattern: 'user.get', data: {} };
      const callback = jest.fn();
      const error = new Error('Publish failed');

      (mockJetStreamClient.publish as jest.Mock).mockRejectedValue(error);

      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proxy as any).publish(packet, callback);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(callback).toHaveBeenCalledWith({
        err: 'Publish failed',
        response: null,
      });
    });

    it('should cleanup pending message on cleanup function call', async () => {
      const packet = { pattern: 'user.get', data: {} };
      const callback = jest.fn();

      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleanup = (proxy as any).publish(packet, callback);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((proxy as any).pendingMessages.size).toBe(1);

      cleanup();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((proxy as any).pendingMessages.size).toBe(0);
    });
  });

  describe('routeReply', () => {
    it('should invoke callback with decoded response', async () => {
      const callback = jest.fn();
      const correlationId = 'test-correlation-id';
      const responseData = { id: 1, name: 'John' };

      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proxy as any).pendingMessages.set(correlationId, callback);

      const mockMsg = {
        data: new TextEncoder().encode(JSON.stringify(responseData)),
        headers: {
          get: jest.fn().mockReturnValue(correlationId),
        },
      } as unknown as Msg;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proxy as any).routeReply(mockMsg);

      expect(callback).toHaveBeenCalledWith({
        err: null,
        response: responseData,
        isDisposed: true,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((proxy as any).pendingMessages.has(correlationId)).toBe(false);
    });

    it('should invoke callback with error on decode failure', async () => {
      const callback = jest.fn();
      const correlationId = 'test-correlation-id';

      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proxy as any).pendingMessages.set(correlationId, callback);

      const mockMsg = {
        data: new Uint8Array([0xff, 0xfe]),
        headers: {
          get: jest.fn().mockReturnValue(correlationId),
        },
      } as unknown as Msg;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proxy as any).routeReply(mockMsg);

      expect(callback).toHaveBeenCalledWith({
        err: expect.any(String),
        response: null,
        isDisposed: true,
      });
    });

    it('should ignore reply without correlation ID', async () => {
      const callback = jest.fn();

      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      const mockMsg = {
        data: new Uint8Array(),
        headers: {
          get: jest.fn().mockReturnValue(undefined),
        },
      } as unknown as Msg;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proxy as any).routeReply(mockMsg);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should warn when no handler found for correlation ID', async () => {
      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      const mockMsg = {
        data: new Uint8Array(),
        headers: {
          get: jest.fn().mockReturnValue('unknown-correlation-id'),
        },
      } as unknown as Msg;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proxy as any).routeReply(mockMsg);

      expect(mockMsg.headers?.get).toHaveBeenCalledWith(JetstreamHeaders.CorrelationId);
    });
  });

  describe('close', () => {
    it('should close connection and cleanup resources', async () => {
      ncSubject.next(mockNatsConnection);

      const connectPromise = proxy.connect();

      await connectPromise;

      await proxy.close();

      expect(mockNatsConnection.close).toHaveBeenCalled();
    });
  });

  describe('buildSubject', () => {
    it('should build correct event subject', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subject = (proxy as any).buildSubject(JetStreamKind.Event, 'user.created');

      expect(subject).toBe('test-service.ev.user.created');
    });

    it('should build correct command subject', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subject = (proxy as any).buildSubject(JetStreamKind.Command, 'user.get');

      expect(subject).toBe('test-service.cmd.user.get');
    });
  });

  describe('createHeaders', () => {
    it('should create headers with required fields', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hdrs = (proxy as any).createHeaders({
        messageId: 'msg-123',
        subject: 'test.subject',
      });

      expect(hdrs.get(JetstreamHeaders.MessageId)).toBe('msg-123');
      expect(hdrs.get(JetstreamHeaders.Subject)).toBe('test.subject');
    });

    it('should include optional correlation ID when provided', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hdrs = (proxy as any).createHeaders({
        messageId: 'msg-123',
        subject: 'test.subject',
        correlationId: 'corr-456',
      });

      expect(hdrs.get(JetstreamHeaders.CorrelationId)).toBe('corr-456');
    });

    it('should include optional reply-to when provided', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hdrs = (proxy as any).createHeaders({
        messageId: 'msg-123',
        subject: 'test.subject',
        replyTo: 'inbox.reply',
      });

      expect(hdrs.get(JetstreamHeaders.ReplyTo)).toBe('inbox.reply');
    });
  });

  describe('unwrap', () => {
    it('should return unwrapped connection', () => {
      const result = proxy.unwrap();

      expect(result).toBe(mockNatsConnection);
    });
  });
});
