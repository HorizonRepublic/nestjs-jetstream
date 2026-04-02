import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { MsgHdrs, NatsConnection } from '@nats-io/transport-node';
import type { JsMsg } from '@nats-io/jetstream';
import { Subject } from 'rxjs';

import { ConnectionProvider } from '../../../connection';
import { EventBus } from '../../../hooks';
import type { Codec } from '../../../interfaces';
import { StreamKind, TransportEvent } from '../../../interfaces';
import { DEFAULT_JETSTREAM_RPC_TIMEOUT, JetstreamHeader } from '../../../jetstream.constants';
import { MessageProvider } from '../../infrastructure';

import { PatternRegistry } from '../pattern-registry';
import { RpcRouter } from '../rpc.router';

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
      it('should subscribe to commands stream', async () => {
        await sut.start();

        expect(commands$.observed).toBe(true);
      });
    });

    describe('when destroyed', () => {
      it('should unsubscribe from commands stream', async () => {
        await sut.start();
        sut.destroy();

        expect(commands$.observed).toBe(false);
      });
    });
  });

  describe('message handling', () => {
    beforeEach(async () => {
      await sut.start();
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
          expect(eventBus.emitMessageRouted).toHaveBeenCalledWith(msg.subject, 'rpc');
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

          const handler = vi.fn().mockResolvedValue(undefined);

          patternRegistry.getHandler.mockReturnValue(handler);

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

          const handler = vi.fn().mockResolvedValue(undefined);

          patternRegistry.getHandler.mockReturnValue(handler);

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

      describe('when nc.publish() throws after handler success', () => {
        it('should still ack the message', async () => {
          // Given: handler succeeds but publish throws
          const handler = vi.fn().mockResolvedValue({ ok: true });

          patternRegistry.getHandler.mockReturnValue(handler);
          mockNc.publish.mockImplementation(() => {
            throw new Error('Connection closed');
          });

          const msg = createRpcMsg('test.cmd', {}, 'reply', 'cid');

          // When: message arrives
          commands$.next(msg);
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Then: message acked despite publish failure
          expect(msg.ack).toHaveBeenCalled();
          expect(msg.term).not.toHaveBeenCalled();
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

        sut = new RpcRouter(messageProvider, patternRegistry, connection, codec, eventBus, {
          timeout: customTimeout,
        });
        await sut.start();

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
        await sut.start();

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

        sut = new RpcRouter(messageProvider, patternRegistry, connection, codec, eventBus, {
          timeout: customTimeout,
        });

        // Then: no error, router created successfully
        expect(sut).toBeDefined();
      });
    });
  });

  describe('concurrency', () => {
    it('should limit concurrent handler execution when concurrency is set', async () => {
      // Given: sut with concurrency = 1
      sut = new RpcRouter(messageProvider, patternRegistry, connection, codec, eventBus, {
        concurrency: 1,
      });
      await sut.start();

      let concurrentCount = 0;
      let maxConcurrent = 0;

      const handler = vi.fn().mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((r) => setTimeout(r, 50));
        concurrentCount--;

        return { ok: true };
      });

      patternRegistry.getHandler.mockReturnValue(handler);

      const msg1 = createRpcMsg('cmd.1', { n: 1 }, faker.string.uuid(), faker.string.uuid());
      const msg2 = createRpcMsg('cmd.2', { n: 2 }, faker.string.uuid(), faker.string.uuid());

      // When: two messages arrive simultaneously
      commands$.next(msg1);
      commands$.next(msg2);

      // Then: only one handler runs at a time
      await new Promise((r) => setTimeout(r, 200));

      expect(maxConcurrent).toBe(1);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should allow unlimited concurrency when no config is set', async () => {
      // Given: default sut (no options)
      await sut.start();

      let concurrentCount = 0;
      let maxConcurrent = 0;

      const handler = vi.fn().mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((r) => setTimeout(r, 50));
        concurrentCount--;

        return { ok: true };
      });

      patternRegistry.getHandler.mockReturnValue(handler);

      const msg1 = createRpcMsg('cmd.1', { n: 1 }, faker.string.uuid(), faker.string.uuid());
      const msg2 = createRpcMsg('cmd.2', { n: 2 }, faker.string.uuid(), faker.string.uuid());

      // When: two messages arrive simultaneously
      commands$.next(msg1);
      commands$.next(msg2);

      // Then: both handlers run in parallel
      await new Promise((r) => setTimeout(r, 200));

      expect(maxConcurrent).toBe(2);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('ack extension', () => {
    it('should call msg.working() periodically when ackExtension is a number', async () => {
      // Given: sut with ackExtension = 50ms
      sut = new RpcRouter(messageProvider, patternRegistry, connection, codec, eventBus, {
        ackExtension: 50,
      });
      await sut.start();

      let resolveHandler!: () => void;
      const handlerPromise = new Promise<void>((r) => {
        resolveHandler = r;
      });
      const handler = vi.fn().mockReturnValue(handlerPromise);

      patternRegistry.getHandler.mockReturnValue(handler);

      const replyTo = faker.string.uuid();
      const correlationId = faker.string.uuid();
      const msg = createRpcMsg('slow.cmd', { test: true }, replyTo, correlationId);

      // When: message arrives and handler is slow
      commands$.next(msg);

      // Then: working() is called periodically while handler is running
      await new Promise((r) => setTimeout(r, 160));
      resolveHandler();
      await new Promise((r) => setTimeout(r, 10));

      expect(msg.working).toHaveBeenCalled();

      const callCount = (msg.working as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('should clear working() interval after handler completes', async () => {
      // Given: sut with ackExtension = 30ms
      sut = new RpcRouter(messageProvider, patternRegistry, connection, codec, eventBus, {
        ackExtension: 30,
      });
      await sut.start();

      const handler = vi.fn().mockResolvedValue({ ok: true });

      patternRegistry.getHandler.mockReturnValue(handler);

      const replyTo = faker.string.uuid();
      const correlationId = faker.string.uuid();
      const msg = createRpcMsg('fast.cmd', { test: true }, replyTo, correlationId);

      // When: message arrives and handler completes quickly
      commands$.next(msg);
      await new Promise((r) => setTimeout(r, 50));

      const countAfterDone = (msg.working as ReturnType<typeof vi.fn>).mock.calls.length;

      // Then: no additional working() calls after handler completes
      await new Promise((r) => setTimeout(r, 100));

      expect((msg.working as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countAfterDone);
    });

    it('should clear working() interval on timeout', async () => {
      vi.useFakeTimers();

      // Given: sut with ackExtension = 50ms and timeout = 200ms
      sut = new RpcRouter(messageProvider, patternRegistry, connection, codec, eventBus, {
        timeout: 200,
        ackExtension: 50,
      });
      await sut.start();

      const handler = vi.fn().mockReturnValue(new Promise(() => {}));

      patternRegistry.getHandler.mockReturnValue(handler);

      const replyTo = faker.string.uuid();
      const correlationId = faker.string.uuid();
      const msg = createRpcMsg('slow.cmd', {}, replyTo, correlationId);

      // When: message arrives and timeout fires
      commands$.next(msg);
      await vi.advanceTimersByTimeAsync(200);

      const countAtTimeout = (msg.working as ReturnType<typeof vi.fn>).mock.calls.length;

      // Then: working() was called before timeout, and no more calls after
      expect(countAtTimeout).toBeGreaterThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(200);

      expect((msg.working as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countAtTimeout);
      expect(msg.term).toHaveBeenCalled();

      sut.destroy();
      vi.useRealTimers();
    });

    it('should not call working() when ackExtension is disabled', async () => {
      // Given: default sut (no ackExtension)
      await sut.start();

      const handler = vi.fn().mockResolvedValue({ ok: true });

      patternRegistry.getHandler.mockReturnValue(handler);

      const replyTo = faker.string.uuid();
      const correlationId = faker.string.uuid();
      const msg = createRpcMsg('fast.cmd', {}, replyTo, correlationId);

      // When: message arrives and is processed
      commands$.next(msg);
      await new Promise((r) => setTimeout(r, 50));

      // Then: working() is never called
      expect(msg.working).not.toHaveBeenCalled();
    });

    it('should auto-calculate interval from ackWaitMap when ackExtension is true', async () => {
      // Given: sut with ackExtension = true and ackWaitMap with 200ms (in nanos) ack_wait
      const ackWaitNanos = 1_000 * 1_000_000; // 1000ms in nanoseconds
      const ackWaitMap = new Map<StreamKind, number>([[StreamKind.Command, ackWaitNanos]]);

      sut = new RpcRouter(
        messageProvider,
        patternRegistry,
        connection,
        codec,
        eventBus,
        { ackExtension: true },
        ackWaitMap,
      );
      await sut.start();

      let resolveHandler!: () => void;
      const handlerPromise = new Promise<void>((r) => {
        resolveHandler = r;
      });
      const handler = vi.fn().mockReturnValue(handlerPromise);

      patternRegistry.getHandler.mockReturnValue(handler);

      const replyTo = faker.string.uuid();
      const correlationId = faker.string.uuid();
      const msg = createRpcMsg('slow.cmd', { test: true }, replyTo, correlationId);

      // When: message arrives and handler is slow
      // Expected interval: max(1000ms / 2, 500) = 500ms
      commands$.next(msg);
      await new Promise((r) => setTimeout(r, 1_100));
      resolveHandler();
      await new Promise((r) => setTimeout(r, 10));

      // Then: working() called ~2 times (at 500ms and 1000ms)
      const callCount = (msg.working as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(callCount).toBeLessThanOrEqual(3);
    });

    it('should use 5s fallback when ackExtension is true but no ackWaitMap entry', async () => {
      // Given: sut with ackExtension = true but no ackWaitMap
      sut = new RpcRouter(messageProvider, patternRegistry, connection, codec, eventBus, {
        ackExtension: true,
      });
      await sut.start();

      const handler = vi.fn().mockResolvedValue({ ok: true });

      patternRegistry.getHandler.mockReturnValue(handler);

      const replyTo = faker.string.uuid();
      const correlationId = faker.string.uuid();
      const msg = createRpcMsg('fast.cmd', {}, replyTo, correlationId);

      // When: message arrives and handler completes quickly
      commands$.next(msg);
      await new Promise((r) => setTimeout(r, 50));

      // Then: no working() calls (5s interval > 50ms wait)
      expect(msg.working).not.toHaveBeenCalled();
    });

    it('should clear working() interval on handler error', async () => {
      // Given: sut with ackExtension = 30ms
      sut = new RpcRouter(messageProvider, patternRegistry, connection, codec, eventBus, {
        ackExtension: 30,
      });
      await sut.start();

      const handler = vi.fn().mockRejectedValue(new Error('handler failed'));

      patternRegistry.getHandler.mockReturnValue(handler);

      const replyTo = faker.string.uuid();
      const correlationId = faker.string.uuid();
      const msg = createRpcMsg('fail.cmd', {}, replyTo, correlationId);

      // When: message arrives and handler errors
      commands$.next(msg);
      await new Promise((r) => setTimeout(r, 50));

      const countAfterError = (msg.working as ReturnType<typeof vi.fn>).mock.calls.length;

      // Then: no additional working() calls after handler error
      await new Promise((r) => setTimeout(r, 100));

      expect((msg.working as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countAfterError);
      expect(msg.term).toHaveBeenCalled();
    });
  });
});
