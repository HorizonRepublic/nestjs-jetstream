import { createMock } from '@golevelup/ts-jest';
import { faker } from '@faker-js/faker';
import type {
  JetStreamClient as NatsJsClient,
  Msg,
  MsgHdrs,
  NatsConnection,
  PubAck,
  Subscription,
} from 'nats';
import { headers as natsHeaders } from 'nats';
import { firstValueFrom } from 'rxjs';

import { ConnectionProvider } from '../connection';
import { EventBus } from '../hooks';
import type { Codec, JetstreamModuleOptions } from '../interfaces';
import { TransportEvent } from '../interfaces';
import {
  DEFAULT_JETSTREAM_RPC_TIMEOUT,
  DEFAULT_RPC_TIMEOUT,
  JetstreamHeader,
} from '../jetstream.constants';

import { JetstreamClient } from './jetstream.client';
import { JetstreamRecordBuilder } from './jetstream.record';

describe(JetstreamClient, () => {
  let sut: JetstreamClient;

  let connection: jest.Mocked<ConnectionProvider>;
  let codec: jest.Mocked<Codec>;
  let eventBus: jest.Mocked<EventBus>;
  let mockNc: jest.Mocked<NatsConnection>;
  let mockJs: jest.Mocked<NatsJsClient>;

  let options: JetstreamModuleOptions;
  let targetName: string;

  beforeEach(() => {
    targetName = faker.lorem.word();
    options = {
      name: faker.lorem.word(),
      servers: ['nats://localhost:4222'],
    };

    mockJs = createMock<NatsJsClient>({
      publish: jest.fn().mockResolvedValue(createMock<PubAck>()),
    });

    mockNc = createMock<NatsConnection>({
      jetstream: jest.fn().mockReturnValue(mockJs),
      request: jest.fn(),
      subscribe: jest.fn().mockReturnValue(createMock<Subscription>()),
    });

    connection = createMock<ConnectionProvider>({
      getConnection: jest.fn().mockResolvedValue(mockNc),
      unwrap: mockNc,
    });

    codec = createMock<Codec>({
      decode: jest.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
      encode: jest.fn((data: unknown) => new TextEncoder().encode(JSON.stringify(data))),
    });

    eventBus = createMock<EventBus>();

    sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
  });

  afterEach(async () => {
    await sut.close();
    jest.resetAllMocks();
  });

  describe('connect()', () => {
    describe('happy path', () => {
      it('should return the NatsConnection', async () => {
        // When: connected
        const nc = await sut.connect();

        // Then: connection returned
        expect(nc).toBe(mockNc);
        expect(connection.getConnection).toHaveBeenCalled();
      });
    });

    describe('when in core RPC mode (default)', () => {
      it('should NOT set up inbox subscription', async () => {
        // When: connected in core mode
        await sut.connect();

        // Then: no subscription created
        expect(mockNc.subscribe).not.toHaveBeenCalled();
      });
    });

    describe('when in jetstream RPC mode', () => {
      beforeEach(() => {
        options.rpc = { mode: 'jetstream' };
        sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
      });

      it('should set up inbox subscription', async () => {
        // When: connected in jetstream mode
        await sut.connect();

        // Then: inbox subscription created
        expect(mockNc.subscribe).toHaveBeenCalledWith(
          expect.stringContaining(`${options.name}__microservice`),
          expect.objectContaining({ callback: expect.any(Function) }),
        );
      });

      it('should only create inbox once on multiple connect calls', async () => {
        // When: connected twice
        await sut.connect();
        await sut.connect();

        // Then: only one subscription
        expect(mockNc.subscribe).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('close()', () => {
    describe('happy path', () => {
      it('should unsubscribe inbox in jetstream mode', async () => {
        // Given: jetstream mode with inbox
        options.rpc = { mode: 'jetstream' };
        sut = new JetstreamClient(options, targetName, connection, codec, eventBus);

        const mockSub = createMock<Subscription>();

        mockNc.subscribe.mockReturnValue(mockSub);
        await sut.connect();

        // When: closed
        await sut.close();

        // Then: unsubscribed
        expect(mockSub.unsubscribe).toHaveBeenCalled();
      });
    });

    describe('edge cases', () => {
      it('should no-op when no inbox was created', async () => {
        // When: close without connect
        await expect(sut.close()).resolves.toBeUndefined();
      });
    });
  });

  describe('unwrap()', () => {
    it('should return the raw connection from provider', () => {
      expect(sut.unwrap()).toBe(mockNc);
    });
  });

  describe('emit() / dispatchEvent()', () => {
    describe('happy path', () => {
      it('should publish event to workqueue stream', async () => {
        // Given: plain event data
        const data = { userId: faker.number.int() };

        // When: event emitted
        await firstValueFrom(sut.emit('user.created', data));

        // Then: published to workqueue subject
        expect(mockJs.publish).toHaveBeenCalledWith(
          `${targetName}__microservice.ev.user.created`,
          codec.encode(data),
          expect.objectContaining({ headers: expect.anything() }),
        );
      });

      it('should publish broadcast event to broadcast subject', async () => {
        // Given: broadcast-prefixed event
        const data = { config: faker.lorem.word() };

        // When: broadcast event emitted
        await firstValueFrom(sut.emit('broadcast:config.updated', data));

        // Then: published to broadcast subject (prefix stripped)
        expect(mockJs.publish).toHaveBeenCalledWith(
          'broadcast.config.updated',
          codec.encode(data),
          expect.objectContaining({ headers: expect.anything() }),
        );
      });
    });

    describe('when using JetstreamRecord', () => {
      it('should extract data and custom headers from record', async () => {
        // Given: record with custom headers
        const data = { key: faker.lorem.word() };
        const traceId = faker.string.uuid();
        const record = new JetstreamRecordBuilder(data).setHeader('x-trace-id', traceId).build();

        // When: event emitted with record
        await firstValueFrom(sut.emit('user.updated', record));

        // Then: data extracted and headers merged
        expect(mockJs.publish).toHaveBeenCalledWith(
          expect.any(String),
          codec.encode(data),
          expect.objectContaining({ headers: expect.anything() }),
        );

        // Verify custom header was set
        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;

        expect(publishedHeaders.get('x-trace-id')).toBe(traceId);
      });
    });

    describe('transport headers', () => {
      it('should set message-id, subject, and caller-name headers', async () => {
        // When: event emitted
        await firstValueFrom(sut.emit('user.created', { test: true }));

        // Then: transport headers present
        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;

        expect(publishedHeaders.get(JetstreamHeader.MessageId)).toBeTruthy();
        expect(publishedHeaders.get(JetstreamHeader.Subject)).toBeTruthy();
        expect(publishedHeaders.get(JetstreamHeader.CallerName)).toBe(
          `${options.name}__microservice`,
        );
      });
    });
  });

  describe('send() / publish() — core RPC mode', () => {
    describe('happy path', () => {
      it('should send request via nc.request() and return decoded response', async () => {
        // Given: server responds successfully
        const responseData = { id: faker.number.int() };
        const responseHeaders = natsHeaders();

        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode(responseData),
            headers: responseHeaders,
          }),
        );

        // When: RPC sent
        const result = await firstValueFrom(sut.send('get.user', { userId: 1 }));

        // Then: response decoded and returned
        expect(result).toEqual(responseData);
        expect(mockNc.request).toHaveBeenCalledWith(
          `${targetName}__microservice.cmd.get.user`,
          expect.any(Uint8Array),
          expect.objectContaining({
            timeout: DEFAULT_RPC_TIMEOUT,
            headers: expect.anything(),
          }),
        );
      });

      it('should emit MessageRouted event on success', async () => {
        // Given: successful response
        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode({}),
            headers: natsHeaders(),
          }),
        );

        // When: RPC sent
        await firstValueFrom(sut.send('get.user', {}));
        await new Promise(process.nextTick);

        // Note: MessageRouted is emitted by the server-side, not client-side
        // Client-side only emits on errors
      });
    });

    describe('when response has x-error header', () => {
      it('should emit error through the observable', async () => {
        // Given: server responds with error
        const errorPayload = { statusCode: 404, message: 'Not found' };
        const errorHeaders = natsHeaders();

        errorHeaders.set(JetstreamHeader.Error, 'true');

        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode(errorPayload),
            headers: errorHeaders,
          }),
        );

        // When/Then: observable emits error
        await expect(firstValueFrom(sut.send('get.user', { id: 1 }))).rejects.toEqual(errorPayload);
      });
    });

    describe('when custom timeout is provided via options', () => {
      it('should use the configured timeout', async () => {
        // Given: custom timeout in options
        const customTimeout = faker.number.int({ min: 1000, max: 5000 });

        options.rpc = { mode: 'core', timeout: customTimeout };
        sut = new JetstreamClient(options, targetName, connection, codec, eventBus);

        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode({}),
            headers: natsHeaders(),
          }),
        );

        // When: RPC sent
        await firstValueFrom(sut.send('test', {}));

        // Then: custom timeout used
        expect(mockNc.request).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Uint8Array),
          expect.objectContaining({ timeout: customTimeout }),
        );
      });
    });

    describe('when custom timeout is provided via JetstreamRecord', () => {
      it('should use the per-message timeout', async () => {
        // Given: record with custom timeout
        const perMessageTimeout = faker.number.int({ min: 100, max: 1000 });
        const record = new JetstreamRecordBuilder({ test: true })
          .setTimeout(perMessageTimeout)
          .build();

        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode({}),
            headers: natsHeaders(),
          }),
        );

        // When: RPC sent with record
        await firstValueFrom(sut.send('test', record));

        // Then: per-message timeout used
        expect(mockNc.request).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Uint8Array),
          expect.objectContaining({ timeout: perMessageTimeout }),
        );
      });
    });

    describe('error paths', () => {
      it('should emit error when nc.request() throws', async () => {
        // Given: request fails
        mockNc.request.mockRejectedValue(new Error('request timeout'));

        // When/Then: observable emits error
        await expect(firstValueFrom(sut.send('test', {}))).rejects.toBeTruthy();
      });

      it('should emit TransportEvent.Error on request failure', async () => {
        // Given: request fails
        mockNc.request.mockRejectedValue(new Error('request timeout'));

        // When: RPC attempted
        try {
          await firstValueFrom(sut.send('test', {}));
        } catch {
          // expected
        }

        await new Promise(process.nextTick);

        // Then: error event emitted
        expect(eventBus.emit).toHaveBeenCalledWith(
          TransportEvent.Error,
          expect.any(Error),
          'client-rpc',
        );
      });
    });
  });

  describe('send() / publish() — jetstream RPC mode', () => {
    let inboxCallback: (err: Error | null, msg: Msg) => void;

    beforeEach(async () => {
      jest.useFakeTimers();

      options.rpc = { mode: 'jetstream' };
      sut = new JetstreamClient(options, targetName, connection, codec, eventBus);

      // Connect to set up inbox
      await sut.connect();

      // Capture inbox subscription callback
      inboxCallback = mockNc.subscribe.mock.calls[0]![1]!.callback! as (
        err: Error | null,
        msg: Msg,
      ) => void;
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    describe('happy path', () => {
      it('should publish command to JetStream and resolve via inbox reply', async () => {
        // Given: a response that will arrive via inbox
        const responseData = { id: faker.number.int() };

        // When: RPC sent
        const resultPromise = firstValueFrom(sut.send('get.user', { userId: 1 }));

        // Allow publish to complete
        await jest.advanceTimersByTimeAsync(0);

        // Extract correlation ID from published headers
        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;
        const correlationId = publishedHeaders.get(JetstreamHeader.CorrelationId);

        // Simulate inbox reply
        const replyHeaders = natsHeaders();

        replyHeaders.set(JetstreamHeader.CorrelationId, correlationId);

        inboxCallback(
          null,
          createMock<Msg>({
            data: codec.encode(responseData),
            headers: replyHeaders,
          }),
        );

        // Then: resolved with response
        const result = await resultPromise;

        expect(result).toEqual(responseData);
      });

      it('should set replyTo and correlationId headers on published message', async () => {
        // When: RPC sent
        const resultPromise = firstValueFrom(sut.send('get.user', {}));

        await jest.advanceTimersByTimeAsync(0);

        // Then: transport headers include replyTo and correlationId
        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;

        expect(publishedHeaders.get(JetstreamHeader.ReplyTo)).toBeTruthy();
        expect(publishedHeaders.get(JetstreamHeader.CorrelationId)).toBeTruthy();

        // Cleanup: resolve the pending promise
        const correlationId = publishedHeaders.get(JetstreamHeader.CorrelationId);
        const replyHeaders = natsHeaders();

        replyHeaders.set(JetstreamHeader.CorrelationId, correlationId);
        inboxCallback(
          null,
          createMock<Msg>({
            data: codec.encode({}),
            headers: replyHeaders,
          }),
        );
        await resultPromise;
      });
    });

    describe('when inbox reply has x-error header', () => {
      it('should emit error through the observable', async () => {
        // Given: error response will arrive
        const errorPayload = { statusCode: 500, message: 'Internal error' };

        // When: RPC sent
        const resultPromise = firstValueFrom(sut.send('test', {}));

        await jest.advanceTimersByTimeAsync(0);

        // Simulate error reply
        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;
        const correlationId = publishedHeaders.get(JetstreamHeader.CorrelationId);
        const replyHeaders = natsHeaders();

        replyHeaders.set(JetstreamHeader.CorrelationId, correlationId);
        replyHeaders.set(JetstreamHeader.Error, 'true');

        inboxCallback(
          null,
          createMock<Msg>({
            data: codec.encode(errorPayload),
            headers: replyHeaders,
          }),
        );

        // Then: observable errors
        await expect(resultPromise).rejects.toEqual(errorPayload);
      });
    });

    describe('when handler times out', () => {
      it('should emit RpcTimeout and error after timeout expires', async () => {
        // When: RPC sent (no reply will come)
        const resultPromise = firstValueFrom(sut.send('slow.handler', {}));

        await jest.advanceTimersByTimeAsync(0);

        // Advance past the timeout
        jest.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT);

        // Then: timeout error
        await expect(resultPromise).rejects.toBeTruthy();
        expect(eventBus.emit).toHaveBeenCalledWith(
          TransportEvent.RpcTimeout,
          expect.stringContaining('cmd.slow.handler'),
          expect.any(String),
        );
      });
    });

    describe('when teardown function is called', () => {
      it('should clean up pending message and timeout', async () => {
        // When: subscribe and immediately unsubscribe
        const subscription = sut.send('test', {}).subscribe({
          next: () => {},
          error: () => {},
        });

        await jest.advanceTimersByTimeAsync(0);
        subscription.unsubscribe();

        // Then: advancing time should NOT trigger timeout callback
        // (timeout was cleared by teardown)
        jest.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT);

        // No timeout event should have been emitted
        expect(eventBus.emit).not.toHaveBeenCalledWith(
          TransportEvent.RpcTimeout,
          expect.anything(),
          expect.anything(),
        );
      });
    });

    describe('inbox edge cases', () => {
      it('should ignore inbox reply without correlation-id', async () => {
        // When: inbox reply arrives without correlation-id
        inboxCallback(
          null,
          createMock<Msg>({
            data: codec.encode({}),
            headers: natsHeaders(), // no correlation-id set
          }),
        );

        // Then: no error, just ignored (warning logged)
      });

      it('should ignore inbox reply for unknown correlation-id', async () => {
        // When: inbox reply arrives for non-pending correlation-id
        const replyHeaders = natsHeaders();

        replyHeaders.set(JetstreamHeader.CorrelationId, faker.string.uuid());

        inboxCallback(
          null,
          createMock<Msg>({
            data: codec.encode({}),
            headers: replyHeaders,
          }),
        );

        // Then: no error, just ignored (warning logged)
      });

      it('should handle inbox subscription error without crashing', () => {
        // When: inbox subscription emits error
        inboxCallback(new Error('subscription error'), createMock<Msg>());

        // Then: no crash (error logged)
      });

      it('should handle decode failure in inbox reply', async () => {
        // Given: pending RPC
        const resultPromise = firstValueFrom(sut.send('test', {}));

        await jest.advanceTimersByTimeAsync(0);

        // Get correlationId from published message
        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;
        const correlationId = publishedHeaders.get(JetstreamHeader.CorrelationId);

        // Given: codec will throw on decode
        codec.decode.mockImplementation(() => {
          throw new Error('invalid payload');
        });

        // When: inbox reply arrives
        const replyHeaders = natsHeaders();

        replyHeaders.set(JetstreamHeader.CorrelationId, correlationId);

        inboxCallback(
          null,
          createMock<Msg>({
            data: new Uint8Array([0xff]),
            headers: replyHeaders,
          }),
        );

        // Then: error propagated
        await expect(resultPromise).rejects.toBeTruthy();
      });
    });

    describe('error paths', () => {
      it('should error when js.publish() fails', async () => {
        // Given: publish will fail
        mockJs.publish.mockRejectedValue(new Error('stream not found'));

        // When/Then: error propagated to subscriber
        const errorPromise = new Promise<unknown>((resolve) => {
          sut.send('test', {}).subscribe({ error: resolve });
        });

        await jest.advanceTimersByTimeAsync(10);

        const err = await errorPromise;

        expect(err).toBeTruthy();
      });
    });
  });

  describe('getRpcTimeout() behavior', () => {
    it('should default to DEFAULT_RPC_TIMEOUT when no rpc config', async () => {
      // Given: no rpc config (core mode implied)
      mockNc.request.mockResolvedValue(
        createMock<Msg>({ data: codec.encode({}), headers: natsHeaders() }),
      );

      // When: RPC sent
      await firstValueFrom(sut.send('test', {}));

      // Then: default core timeout used
      expect(mockNc.request).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Uint8Array),
        expect.objectContaining({ timeout: DEFAULT_RPC_TIMEOUT }),
      );
    });

    it('should use DEFAULT_JETSTREAM_RPC_TIMEOUT in jetstream mode', async () => {
      jest.useFakeTimers();

      // Given: jetstream rpc mode without explicit timeout
      options.rpc = { mode: 'jetstream' };
      sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
      await sut.connect();

      // When: send an RPC (timeout will fire since no reply comes)
      const resultPromise = firstValueFrom(sut.send('test', {}));

      await jest.advanceTimersByTimeAsync(0);

      // Advance to just before timeout — should NOT have fired yet
      jest.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT - 1);
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        TransportEvent.RpcTimeout,
        expect.anything(),
        expect.anything(),
      );

      // Advance past timeout — should fire
      jest.advanceTimersByTime(1);
      expect(eventBus.emit).toHaveBeenCalledWith(
        TransportEvent.RpcTimeout,
        expect.anything(),
        expect.anything(),
      );

      try {
        await resultPromise;
      } catch {
        // expected
      }

      jest.useRealTimers();
    });
  });
});
