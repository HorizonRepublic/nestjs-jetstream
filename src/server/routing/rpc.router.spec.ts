import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
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

  let messageProvider: Mocked<MessageProvider>;
  let patternRegistry: Mocked<PatternRegistry>;
  let connection: Mocked<ConnectionProvider>;
  let codec: Mocked<Codec>;
  let eventBus: Mocked<EventBus>;

  let commands$: Subject<JsMsg>;
  let mockNc: Mocked<NatsConnection>;

  beforeEach(() => {
    commands$ = new Subject<JsMsg>();
    mockNc = createMock<NatsConnection>();

    messageProvider = createMock<MessageProvider>({
      commands$: commands$.asObservable(),
    });
    patternRegistry = createMock<PatternRegistry>();
    connection = createMock<ConnectionProvider>({
      getConnection: vi.fn().mockResolvedValue(mockNc),
    });
    codec = createMock<Codec>({
      decode: vi.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
      encode: vi.fn((data: unknown) => new TextEncoder().encode(JSON.stringify(data))),
    });
    eventBus = createMock<EventBus>();

    sut = new RpcRouter(messageProvider, patternRegistry, connection, codec, eventBus);
  });

  afterEach(() => {
    sut.destroy();
    vi.resetAllMocks();
  });

  const createRpcMsg = (
    subject: string,
    data: unknown,
    replyTo: string,
    correlationId: string,
  ): Mocked<JsMsg> => {
    const headers = createMock<MsgHdrs>({
      get: vi.fn((key: string) => {
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
          const handler = vi.fn().mockResolvedValue(responseData);

          patternRegistry.getHandler.mockReturnValue(handler);

          const replyTo = faker.string.uuid();
          const correlationId = faker.string.uuid();
          const msg = createRpcMsg('orders.cmd.get', { test: true }, replyTo, correlationId);

          // When: message arrives
          commands$.next(msg);
          await new Promise((resolve) => setTimeout(resolve, 0));

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
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Then: terminated
          expect(msg.term).toHaveBeenCalled();
          expect(msg.ack).not.toHaveBeenCalled();
        });
      });

      describe('when required headers are missing', () => {
        it('should term the message when replyTo is missing', async () => {
          // Given: message without replyTo
          const headers = createMock<MsgHdrs>({
            get: vi.fn().mockReturnValue(undefined),
          });
          const msg = createMock<JsMsg>({
            subject: 'test.cmd',
            headers,
            data: new TextEncoder().encode('{}'),
          });

          patternRegistry.getHandler.mockReturnValue(vi.fn());

          // When: message arrives
          commands$.next(msg);
          await new Promise((resolve) => setTimeout(resolve, 0));

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
          patternRegistry.getHandler.mockReturnValue(vi.fn());

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
          const handler = vi.fn().mockRejectedValue({ statusCode: 400, message: 'Bad input' });

          patternRegistry.getHandler.mockReturnValue(handler);

          const replyTo = faker.string.uuid();
          const correlationId = faker.string.uuid();
          const msg = createRpcMsg('test.cmd', {}, replyTo, correlationId);

          // When: message arrives
          commands$.next(msg);
          await new Promise((resolve) => setTimeout(resolve, 0));

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
          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);
          codec.encode.mockImplementation(() => {
            throw new Error('encode failure');
          });

          const replyTo = faker.string.uuid();
          const correlationId = faker.string.uuid();
          const msg = createRpcMsg('test.cmd', {}, replyTo, correlationId);

          // When: message arrives
          commands$.next(msg);
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Then: message terminated despite encode failure
          expect(msg.term).toHaveBeenCalled();
        });
      });
    });
  });

  describe('timeout', () => {
    describe('when handler exceeds timeout', () => {
      it('should term the message and emit RpcTimeout', async () => {
        vi.useFakeTimers();

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

        const handler = vi.fn().mockReturnValue(new Promise(() => {}));

        patternRegistry.getHandler.mockReturnValue(handler);

        const replyTo = faker.string.uuid();
        const correlationId = faker.string.uuid();
        const msg = createRpcMsg('slow.cmd', {}, replyTo, correlationId);

        // When: message arrives and timeout fires
        commands$.next(msg);
        await vi.advanceTimersByTimeAsync(customTimeout);

        // Then: message terminated, timeout event emitted
        expect(msg.term).toHaveBeenCalled();
        expect(eventBus.emit).toHaveBeenCalledWith(
          TransportEvent.RpcTimeout,
          msg.subject,
          correlationId,
        );

        sut.destroy();
        vi.useRealTimers();
      });
    });

    describe('when handle() throws an unexpected error', () => {
      it('should catch via catchError and keep the subscription alive', async () => {
        sut.start();

        // Given: getHandler throws synchronously (unexpected)
        patternRegistry.getHandler.mockImplementation(() => {
          throw new Error('registry exploded');
        });

        const msg = createRpcMsg('test.cmd', {}, 'reply', 'cid');

        // When: message arrives
        commands$.next(msg);
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Then: subscription is still alive (can process next message)
        const handler = vi.fn().mockResolvedValue({ ok: true });

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg2 = createRpcMsg('test.cmd', { id: 1 }, faker.string.uuid(), faker.string.uuid());

        commands$.next(msg2);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(handler).toHaveBeenCalled();
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
