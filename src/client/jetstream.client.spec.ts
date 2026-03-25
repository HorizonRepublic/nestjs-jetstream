import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type {
  JetStreamClient as NatsJsClient,
  Msg,
  MsgHdrs,
  NatsConnection,
  PubAck,
  Subscription,
} from 'nats';
import { Events, headers as natsHeaders } from 'nats';
import type { Status } from 'nats';
import { firstValueFrom, Subject } from 'rxjs';

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

  let connection: Mocked<ConnectionProvider>;
  let codec: Mocked<Codec>;
  let eventBus: Mocked<EventBus>;
  let mockNc: Mocked<NatsConnection>;
  let mockJs: Mocked<NatsJsClient>;

  let options: JetstreamModuleOptions;
  let targetName: string;
  let statusSubject: Subject<Status>;

  beforeEach(() => {
    statusSubject = new Subject<Status>();
    targetName = faker.lorem.word();
    options = {
      name: faker.lorem.word(),
      servers: ['nats://localhost:4222'],
    };

    mockJs = createMock<NatsJsClient>({
      publish: vi.fn().mockResolvedValue({ stream: 'test', seq: 1, duplicate: false } as PubAck),
    });

    mockNc = createMock<NatsConnection>({
      request: vi.fn(),
      subscribe: vi.fn().mockReturnValue(createMock<Subscription>()),
    });

    connection = createMock<ConnectionProvider>({
      getConnection: vi.fn().mockResolvedValue(mockNc),
      getJetStreamClient: vi.fn().mockReturnValue(mockJs),
      unwrap: mockNc,
      status$: statusSubject.asObservable(),
    });

    codec = createMock<Codec>({
      decode: vi.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
      encode: vi.fn((data: unknown) => new TextEncoder().encode(JSON.stringify(data))),
    });

    eventBus = createMock<EventBus>();

    sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
  });

  afterEach(async () => {
    await sut.close();
    vi.resetAllMocks();
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

    it('should throw when connection is not established', () => {
      // Given: connection.unwrap returns null
      Object.defineProperty(connection, 'unwrap', { get: () => null, configurable: true });

      // When/Then
      expect(() => sut.unwrap()).toThrow('Not connected');
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

      it('should publish ordered event to ordered subject', async () => {
        // Given: ordered-prefixed event
        const data = { status: faker.lorem.word() };

        // When: ordered event emitted
        await firstValueFrom(sut.emit('ordered:order.status', data));

        // Then: published to ordered subject (prefix stripped)
        expect(mockJs.publish).toHaveBeenCalledWith(
          `${targetName}__microservice.ordered.order.status`,
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
      it('should set subject and caller-name headers', async () => {
        // When: event emitted
        await firstValueFrom(sut.emit('user.created', { test: true }));

        // Then: transport headers present
        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;

        expect(publishedHeaders.get(JetstreamHeader.Subject)).toBeTruthy();
        expect(publishedHeaders.get(JetstreamHeader.CallerName)).toBe(
          `${options.name}__microservice`,
        );
      });
    });

    describe('duplicate detection', () => {
      it('should log warning when JetStream returns a duplicate ack', async () => {
        // Given: publish returns duplicate: true
        mockJs.publish.mockResolvedValue({ stream: 'test', seq: 1, duplicate: true } as PubAck);

        const loggerWarnSpy = vi.spyOn(sut['logger'], 'warn');

        // When
        await firstValueFrom(sut.emit('order.created', { id: 1 }));

        // Then
        expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Duplicate'));
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

      it('should resolve without error on success', async () => {
        // Given: successful response
        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode({ ok: true }),
            headers: natsHeaders(),
          }),
        );

        // When: RPC sent
        const result = await firstValueFrom(sut.send('get.user', {}));

        // Then: result decoded
        expect(result).toEqual({ ok: true });
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
      it('should reject with Error instance when nc.request() throws', async () => {
        // Given: request fails
        mockNc.request.mockRejectedValue(new Error('request timeout'));

        // When/Then: observable rejects with Error instance
        await expect(firstValueFrom(sut.send('test', {}))).rejects.toThrow('request timeout');
      });

      it('should reject with Error instance for non-Error throw', async () => {
        // Given: request fails with non-Error
        mockNc.request.mockRejectedValue('some string error');

        // When/Then: wrapped in Error
        await expect(firstValueFrom(sut.send('test', {}))).rejects.toThrow('Unknown error');
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
      vi.useFakeTimers();

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
      vi.useRealTimers();
    });

    describe('happy path', () => {
      it('should publish command to JetStream and resolve via inbox reply', async () => {
        // Given: a response that will arrive via inbox
        const responseData = { id: faker.number.int() };

        // When: RPC sent
        const resultPromise = firstValueFrom(sut.send('get.user', { userId: 1 }));

        // Allow publish to complete
        await vi.advanceTimersByTimeAsync(0);

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

        await vi.advanceTimersByTimeAsync(0);

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

        await vi.advanceTimersByTimeAsync(0);

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
      it('should reject with Error instance on timeout', async () => {
        // When: RPC sent (no reply will come)
        const resultPromise = firstValueFrom(sut.send('slow.handler', {}));

        await vi.advanceTimersByTimeAsync(0);

        // Advance past the timeout
        vi.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT);

        // Then: timeout error as Error instance
        await expect(resultPromise).rejects.toThrow('RPC timeout');
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

        await vi.advanceTimersByTimeAsync(0);
        subscription.unsubscribe();

        // Then: advancing time should NOT trigger timeout callback
        // (timeout was cleared by teardown)
        vi.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT);

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
        // When/Then: inbox reply arrives without correlation-id — no crash
        expect(() => {
          inboxCallback(
            null,
            createMock<Msg>({
              data: codec.encode({}),
              headers: natsHeaders(), // no correlation-id set
            }),
          );
        }).not.toThrow();
      });

      it('should ignore inbox reply for unknown correlation-id', async () => {
        // When: inbox reply arrives for non-pending correlation-id
        const replyHeaders = natsHeaders();

        replyHeaders.set(JetstreamHeader.CorrelationId, faker.string.uuid());

        // Then: no crash
        expect(() => {
          inboxCallback(
            null,
            createMock<Msg>({
              data: codec.encode({}),
              headers: replyHeaders,
            }),
          );
        }).not.toThrow();
      });

      it('should handle inbox subscription error without crashing', () => {
        // When/Then: inbox subscription emits error without crash
        expect(() => {
          inboxCallback(new Error('subscription error'), createMock<Msg>());
        }).not.toThrow();
      });

      it('should reject with Error instance on decode failure in inbox reply', async () => {
        // Given: pending RPC
        const resultPromise = firstValueFrom(sut.send('test', {}));

        await vi.advanceTimersByTimeAsync(0);

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

        // Then: error propagated as Error instance
        await expect(resultPromise).rejects.toThrow('invalid payload');
      });
    });

    describe('error paths', () => {
      it('should reject with Error instance when js.publish() fails', async () => {
        // Given: publish will fail
        mockJs.publish.mockRejectedValue(new Error('stream not found'));

        // When/Then: error propagated as Error instance
        const errorPromise = new Promise<unknown>((resolve) => {
          sut.send('test', {}).subscribe({ error: resolve });
        });

        await vi.advanceTimersByTimeAsync(10);

        const err = await errorPromise;

        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('stream not found');
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
      vi.useFakeTimers();

      // Given: jetstream rpc mode without explicit timeout
      options.rpc = { mode: 'jetstream' };
      sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
      await sut.connect();

      // When: send an RPC (timeout will fire since no reply comes)
      const resultPromise = firstValueFrom(sut.send('test', {}));

      await vi.advanceTimersByTimeAsync(0);

      // Advance to just before timeout — should NOT have fired yet
      vi.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT - 1);
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        TransportEvent.RpcTimeout,
        expect.anything(),
        expect.anything(),
      );

      // Advance past timeout — should fire
      vi.advanceTimersByTime(1);
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

      vi.useRealTimers();
    });
  });

  describe('disconnect handling (JetStream RPC mode)', () => {
    beforeEach(async () => {
      vi.useFakeTimers();

      options.rpc = { mode: 'jetstream' };
      sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
      await sut.connect();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should reject all pending callbacks with Error on disconnect', async () => {
      // Given: two pending RPCs
      const result1 = firstValueFrom(sut.send('rpc.one', {}));
      const result2 = firstValueFrom(sut.send('rpc.two', {}));

      await vi.advanceTimersByTimeAsync(0);

      // When: disconnect event fires
      statusSubject.next({ type: Events.Disconnect, data: '' });

      // Then: both reject with Error('Connection lost')
      await expect(result1).rejects.toThrow('Connection lost');
      await expect(result2).rejects.toThrow('Connection lost');
    });

    it('should clear pending maps on disconnect', async () => {
      // Given: pending RPC
      firstValueFrom(sut.send('rpc.one', {})).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // When: disconnect
      statusSubject.next({ type: Events.Disconnect, data: '' });

      // Then: advancing past timeout should NOT trigger RpcTimeout (already cleaned up)
      vi.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT);
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        TransportEvent.RpcTimeout,
        expect.anything(),
        expect.anything(),
      );
    });

    it('should reset inbox subscription on disconnect', async () => {
      // Given: inbox was set up
      expect(mockNc.subscribe).toHaveBeenCalledTimes(1);

      // When: disconnect
      statusSubject.next({ type: Events.Disconnect, data: '' });

      // Then: next connect() should set up inbox again
      await sut.connect();
      expect(mockNc.subscribe).toHaveBeenCalledTimes(2);
    });

    it('should clearTimeout for pending RPCs on disconnect', async () => {
      // Given: a pending RPC with an active timeout
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      firstValueFrom(sut.send('rpc.one', {})).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // When: disconnect event fires
      statusSubject.next({ type: Events.Disconnect, data: '' });

      // Then: clearTimeout was called for the pending RPC timeout
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('should not affect core RPC mode on disconnect', async () => {
      // Given: core mode client
      options.rpc = undefined;
      const coreClient = new JetstreamClient(options, targetName, connection, codec, eventBus);

      await coreClient.connect();

      // When/Then: disconnect fires — no crash
      expect(() => {
        statusSubject.next({ type: Events.Disconnect, data: '' });
      }).not.toThrow();

      await coreClient.close();
    });
  });
});
