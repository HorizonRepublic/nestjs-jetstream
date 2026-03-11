import { createMock } from '@golevelup/ts-jest';
import { faker } from '@faker-js/faker';
import type { JsMsg, MsgHdrs, NatsConnection } from 'nats';
import { Subject } from 'rxjs';

import { ConnectionProvider } from '../../connection';
import { EventBus } from '../../hooks';
import type { Codec } from '../../interfaces';
import { TransportEvent } from '../../interfaces';
import { DEFAULT_JETSTREAM_RPC_TIMEOUT, JetstreamHeader } from '../../jetstream.constants';
import { MessageProvider } from '../infrastructure/message.provider';

import { PatternRegistry } from './pattern-registry';
import { RpcRouter } from './rpc.router';

describe(RpcRouter, () => {
  let sut: RpcRouter;

  let messageProvider: jest.Mocked<MessageProvider>;
  let patternRegistry: jest.Mocked<PatternRegistry>;
  let connection: jest.Mocked<ConnectionProvider>;
  let codec: jest.Mocked<Codec>;
  let eventBus: jest.Mocked<EventBus>;

  let commands$: Subject<JsMsg>;
  let mockNc: jest.Mocked<NatsConnection>;

  beforeEach(() => {
    commands$ = new Subject<JsMsg>();
    mockNc = createMock<NatsConnection>();

    messageProvider = createMock<MessageProvider>({
      commands$: commands$.asObservable(),
    });
    patternRegistry = createMock<PatternRegistry>();
    connection = createMock<ConnectionProvider>({
      getConnection: jest.fn().mockResolvedValue(mockNc),
    });
    codec = createMock<Codec>({
      decode: jest.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
      encode: jest.fn((data: unknown) => new TextEncoder().encode(JSON.stringify(data))),
    });
    eventBus = createMock<EventBus>();

    sut = new RpcRouter(messageProvider, patternRegistry, connection, codec, eventBus);
  });

  afterEach(() => {
    sut.destroy();
    jest.resetAllMocks();
  });

  const createRpcMsg = (
    subject: string,
    data: unknown,
    replyTo: string,
    correlationId: string,
  ): jest.Mocked<JsMsg> => {
    const headers = createMock<MsgHdrs>({
      get: jest.fn((key: string) => {
        if (key === JetstreamHeader.ReplyTo) return replyTo;
        if (key === JetstreamHeader.CorrelationId) return correlationId;

        return '';
      }),
    });

    return createMock<JsMsg>({
      subject,
      headers,
      data: new TextEncoder().encode(JSON.stringify(data)),
    });
  };

  describe('start() / destroy()', () => {
    describe('happy path', () => {
      it('should subscribe to commands stream', () => {
        sut.start();

        expect(commands$.observed).toBe(true);
      });
    });

    describe('when destroyed', () => {
      it('should unsubscribe from commands stream', () => {
        sut.start();
        sut.destroy();

        expect(commands$.observed).toBe(false);
      });
    });
  });

  describe('message handling', () => {
    beforeEach(() => {
      sut.start();
    });

    describe('happy path', () => {
      describe('when handler returns a result', () => {
        it('should publish response to replyTo and ack the message', async () => {
          // Given: a handler that returns data
          const responseData = { id: faker.number.int() };
          const handler = jest.fn().mockResolvedValue(responseData);

          patternRegistry.getHandler.mockReturnValue(handler);

          const replyTo = faker.string.uuid();
          const correlationId = faker.string.uuid();
          const msg = createRpcMsg('orders.cmd.get', { test: true }, replyTo, correlationId);

          // When: message arrives
          commands$.next(msg);
          await new Promise(process.nextTick);

          // Then: response published and message acked
          expect(mockNc.publish).toHaveBeenCalledWith(
            replyTo,
            codec.encode(responseData),
            expect.objectContaining({ headers: expect.anything() }),
          );
          expect(msg.ack).toHaveBeenCalled();
          expect(eventBus.emit).toHaveBeenCalledWith(
            TransportEvent.MessageRouted,
            msg.subject,
            'rpc',
          );
        });
      });
    });

    describe('edge cases', () => {
      describe('when no handler is found', () => {
        it('should term the message', async () => {
          // Given: no handler
          patternRegistry.getHandler.mockReturnValue(null);

          const msg = createRpcMsg('unknown.cmd', {}, 'reply', 'cid');

          // When: message arrives
          commands$.next(msg);
          await new Promise(process.nextTick);

          // Then: terminated
          expect(msg.term).toHaveBeenCalled();
          expect(msg.ack).not.toHaveBeenCalled();
        });
      });

      describe('when required headers are missing', () => {
        it('should term the message when replyTo is missing', async () => {
          // Given: message without replyTo
          const headers = createMock<MsgHdrs>({
            get: jest.fn().mockReturnValue(undefined),
          });
          const msg = createMock<JsMsg>({
            subject: 'test.cmd',
            headers,
            data: new TextEncoder().encode('{}'),
          });

          patternRegistry.getHandler.mockReturnValue(jest.fn());

          // When: message arrives
          commands$.next(msg);
          await new Promise(process.nextTick);

          // Then: terminated
          expect(msg.term).toHaveBeenCalled();
        });
      });
    });

    describe('error paths', () => {
      describe('when codec.decode() throws', () => {
        it('should term the message', async () => {
          // Given: decode fails
          codec.decode.mockImplementation(() => {
            throw new Error('bad payload');
          });
          patternRegistry.getHandler.mockReturnValue(jest.fn());

          const msg = createRpcMsg('test.cmd', {}, 'reply', 'cid');

          // When: message arrives
          commands$.next(msg);
          await new Promise(process.nextTick);

          // Then: terminated without ack
          expect(msg.term).toHaveBeenCalled();
          expect(msg.ack).not.toHaveBeenCalled();
        });
      });

      describe('when handler throws', () => {
        it('should publish error with x-error header and term the message', async () => {
          // Given: handler that throws
          const handler = jest.fn().mockRejectedValue({ statusCode: 400, message: 'Bad input' });

          patternRegistry.getHandler.mockReturnValue(handler);

          const replyTo = faker.string.uuid();
          const correlationId = faker.string.uuid();
          const msg = createRpcMsg('test.cmd', {}, replyTo, correlationId);

          // When: message arrives
          commands$.next(msg);
          await new Promise(process.nextTick);

          // Then: error published to replyTo, message terminated
          expect(mockNc.publish).toHaveBeenCalledWith(
            replyTo,
            expect.any(Uint8Array),
            expect.objectContaining({ headers: expect.anything() }),
          );
          expect(msg.term).toHaveBeenCalled();
          expect(msg.ack).not.toHaveBeenCalled();
        });
      });

      describe('when error response encoding fails', () => {
        it('should still term the message without publishing', async () => {
          // Given: handler throws AND codec.encode throws on the error
          const handler = jest.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);
          codec.encode.mockImplementation(() => {
            throw new Error('encode failure');
          });

          const replyTo = faker.string.uuid();
          const correlationId = faker.string.uuid();
          const msg = createRpcMsg('test.cmd', {}, replyTo, correlationId);

          // When: message arrives
          commands$.next(msg);
          await new Promise(process.nextTick);

          // Then: message terminated despite encode failure
          expect(msg.term).toHaveBeenCalled();
        });
      });
    });
  });

  describe('timeout', () => {
    describe('when handler exceeds timeout', () => {
      it('should term the message and emit RpcTimeout', async () => {
        jest.useFakeTimers();

        // Given: short timeout and a handler that never resolves
        const customTimeout = 100;

        sut = new RpcRouter(
          messageProvider,
          patternRegistry,
          connection,
          codec,
          eventBus,
          customTimeout,
        );
        sut.start();

        const handler = jest.fn().mockReturnValue(new Promise(() => {}));

        patternRegistry.getHandler.mockReturnValue(handler);

        const replyTo = faker.string.uuid();
        const correlationId = faker.string.uuid();
        const msg = createRpcMsg('slow.cmd', {}, replyTo, correlationId);

        // When: message arrives and timeout fires
        commands$.next(msg);
        await jest.advanceTimersByTimeAsync(0);
        jest.advanceTimersByTime(customTimeout);
        await jest.advanceTimersByTimeAsync(0);

        // Then: message terminated, timeout event emitted
        expect(msg.term).toHaveBeenCalled();
        expect(eventBus.emit).toHaveBeenCalledWith(
          TransportEvent.RpcTimeout,
          msg.subject,
          correlationId,
        );

        sut.destroy();
        jest.useRealTimers();
      });
    });

    describe('when no custom timeout provided', () => {
      it('should use DEFAULT_JETSTREAM_RPC_TIMEOUT', () => {
        expect(DEFAULT_JETSTREAM_RPC_TIMEOUT).toBe(180_000);
      });
    });

    describe('when custom timeout provided', () => {
      it('should use the custom value', () => {
        // Given: custom timeout
        const customTimeout = faker.number.int({ min: 1000, max: 5000 });

        sut = new RpcRouter(
          messageProvider,
          patternRegistry,
          connection,
          codec,
          eventBus,
          customTimeout,
        );

        // Then: no error, router created successfully
        expect(sut).toBeDefined();
      });
    });
  });
});
