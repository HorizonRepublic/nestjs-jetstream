import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type Mocked } from 'vitest';
import { Logger } from '@nestjs/common';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { DeliveryInfo, JsMsg } from '@nats-io/jetstream';
import { Subject } from 'rxjs';

import { EventBus } from '../../../hooks';
import type { Codec } from '../../../interfaces';
import { TransportEvent } from '../../../interfaces';
import { MessageProvider } from '../../infrastructure';

import { RpcContext } from '../../../context';
import { StreamKind } from '../../../interfaces';
import type {
  DeadLetterConfig,
  EventProcessingConfig,
  JetstreamModuleOptions,
} from '../../../interfaces';
import { EventRouter } from '../event.router';
import { PatternRegistry } from '../pattern-registry';
import { ConnectionProvider } from '../../../connection';
import { dlqStreamName, JetstreamDlqHeader } from '../../../jetstream.constants';
import { NameResolver } from '../../infrastructure/name-resolver';

describe(EventRouter, () => {
  let sut: EventRouter;

  let messageProvider: Mocked<MessageProvider>;
  let patternRegistry: Mocked<PatternRegistry>;
  let codec: Mocked<Codec>;
  let eventBus: Mocked<EventBus>;

  let events$: Subject<JsMsg>;
  let broadcasts$: Subject<JsMsg>;

  beforeEach(() => {
    events$ = new Subject<JsMsg>();
    broadcasts$ = new Subject<JsMsg>();

    messageProvider = createMock<MessageProvider>({
      events$: events$.asObservable(),
      broadcasts$: broadcasts$.asObservable(),
    });
    patternRegistry = createMock<PatternRegistry>();
    codec = createMock<Codec>({
      decode: vi.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
    });
    eventBus = createMock<EventBus>();

    sut = new EventRouter(messageProvider, patternRegistry, codec, eventBus);
  });

  afterEach(vi.resetAllMocks);

  describe('start() / destroy()', () => {
    describe('happy path', () => {
      describe('when started', () => {
        it('should subscribe to events and broadcasts streams', () => {
          // Given: streams have observers
          sut.start();

          // Then: subscribed to both
          expect(events$.observed).toBe(true);
          expect(broadcasts$.observed).toBe(true);
        });
      });
    });

    describe('when destroyed after start', () => {
      it('should unsubscribe from all streams', () => {
        // Given: started
        sut.start();

        // When: destroyed
        sut.destroy();

        // Then: no more observers
        expect(events$.observed).toBe(false);
        expect(broadcasts$.observed).toBe(false);
      });
    });
  });

  describe('routing resilience', () => {
    it('should release the slot when a post-settlement hook throws on the sync path', async () => {
      // Given: concurrency 1; HandlerCompleted reporting is enabled and the
      // hook throws — the failure escapes settlement and hits the limiter
      const processingConfig: EventProcessingConfig = { events: { concurrency: 1 } };

      eventBus.hasHook.mockReturnValue(true);
      eventBus.emit.mockImplementation(() => {
        throw new Error('hook exploded');
      });

      sut = new EventRouter(
        messageProvider,
        patternRegistry,
        codec,
        eventBus,
        undefined,
        processingConfig,
      );
      sut.start();

      const handler = vi.fn().mockReturnValue(undefined);

      patternRegistry.getHandler.mockReturnValue(handler);

      const first = createMock<JsMsg>({
        subject: 'first.subject',
        data: new TextEncoder().encode(JSON.stringify({})),
      });
      const second = createMock<JsMsg>({
        subject: 'second.subject',
        data: new TextEncoder().encode(JSON.stringify({})),
      });

      // When
      events$.next(first);
      events$.next(second);
      await new Promise(process.nextTick);

      // Then: both messages were settled despite the throwing hook
      expect(handler).toHaveBeenCalledTimes(2);
      expect(first.ack).toHaveBeenCalled();
      expect(second.ack).toHaveBeenCalled();
    });

    it('should log and not crash when the message stream errors', () => {
      // Given
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      sut.start();

      // When: the underlying observable errors
      events$.error(new Error('stream exploded'));

      // Then
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stream error'),
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });

    it('should log and survive a failing dead-letter capture for unroutable messages', async () => {
      // Given: dlq configured, no handler for the subject, and the capture
      // chain rejects (the DeadLetter hook emit throws)
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const options: JetstreamModuleOptions = {
        name: 'my-service',
        servers: ['nats://localhost:4222'],
        dlq: {},
      };
      const dlqConfig: DeadLetterConfig = { maxDeliverByStream: new Map() };
      const connection = createMock<ConnectionProvider>({
        getJetStreamClient: vi.fn().mockReturnValue({ publish: vi.fn() }),
      });

      eventBus.emit.mockImplementation(() => {
        throw new Error('hook exploded');
      });

      sut = new EventRouter(
        messageProvider,
        patternRegistry,
        codec,
        eventBus,
        dlqConfig,
        undefined,
        undefined,
        connection,
        options,
      );
      sut.start();

      patternRegistry.getHandler.mockReturnValue(null);

      const msg = createMock<JsMsg>({
        subject: 'orphan.subject',
        data: new TextEncoder().encode(JSON.stringify({})),
      });

      // When: the unroutable message arrives
      events$.next(msg);
      await new Promise(process.nextTick);

      // Then: the failure is logged, nothing escapes as an unhandled rejection
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dead-letter capture failed for unroutable'),
        expect.anything(),
      );

      errorSpy.mockRestore();
    });
  });

  describe('settlement resilience', () => {
    const createSettleMsg = (subject: string, ackImpl?: () => void): JsMsg =>
      createMock<JsMsg>({
        subject,
        data: new TextEncoder().encode(JSON.stringify({})),
        ...(ackImpl ? { ack: vi.fn(ackImpl) } : {}),
      });

    it('should keep routing after ack throws on the sync path with bounded concurrency', async () => {
      // Given: concurrency 1 and a sync handler; the first message's ack
      // throws (settlement is a publish — it fails when the connection drops)
      const processingConfig: EventProcessingConfig = { events: { concurrency: 1 } };

      sut = new EventRouter(
        messageProvider,
        patternRegistry,
        codec,
        eventBus,
        undefined,
        processingConfig,
      );
      sut.start();

      const handler = vi.fn().mockReturnValue(undefined);

      patternRegistry.getHandler.mockReturnValue(handler);

      const failing = createSettleMsg('first.subject', () => {
        throw new Error('connection closed');
      });
      const healthy = createSettleMsg('second.subject');

      // When: both messages arrive
      events$.next(failing);
      events$.next(healthy);
      await new Promise(process.nextTick);

      // Then: the slot was released and the second message processed normally
      expect(handler).toHaveBeenCalledTimes(2);
      expect(healthy.ack).toHaveBeenCalled();
    });

    it('should free the concurrency slot when settlement fails on the async path', async () => {
      // Given: concurrency 1 and an async handler; the first message's ack throws
      const processingConfig: EventProcessingConfig = { events: { concurrency: 1 } };

      sut = new EventRouter(
        messageProvider,
        patternRegistry,
        codec,
        eventBus,
        undefined,
        processingConfig,
      );
      sut.start();

      const handler = vi.fn().mockResolvedValue(undefined);

      patternRegistry.getHandler.mockReturnValue(handler);

      const failing = createSettleMsg('first.subject', () => {
        throw new Error('connection closed');
      });
      const healthy = createSettleMsg('second.subject');

      // When: both messages arrive
      events$.next(failing);
      events$.next(healthy);
      await new Promise(process.nextTick);
      await new Promise(process.nextTick);

      // Then: no unhandled rejection escapes and the second message is processed
      expect(handler).toHaveBeenCalledTimes(2);
      expect(healthy.ack).toHaveBeenCalled();
    });
  });

  describe('message handling', () => {
    beforeEach(() => {
      sut.start();
    });

    describe('happy path', () => {
      describe('when handler succeeds', () => {
        it('should ack the message', async () => {
          // Given: a handler that resolves
          const handler = vi.fn().mockResolvedValue(undefined);

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createMock<JsMsg>({
            subject: faker.lorem.word(),
            data: new TextEncoder().encode(JSON.stringify({ test: true })),
          });

          // When: message arrives
          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: handler called, message acked, event emitted
          expect(handler).toHaveBeenCalled();
          expect(msg.ack).toHaveBeenCalled();
          expect(eventBus.emitMessageRouted).toHaveBeenCalledWith(msg.subject, 'event');
        });
      });
    });

    describe('edge cases', () => {
      describe('when no handler is found', () => {
        it('should term the message', async () => {
          // Given: no handler
          patternRegistry.getHandler.mockReturnValue(null);

          const msg = createMock<JsMsg>({
            subject: 'unknown.subject',
            data: new Uint8Array(),
          });

          // When: message arrives
          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: message terminated, not acked
          expect(msg.term).toHaveBeenCalled();
          expect(msg.ack).not.toHaveBeenCalled();
        });
      });
    });

    describe('error paths', () => {
      describe('when codec.decode() throws', () => {
        it('should term the message without calling handler', async () => {
          // Given: decode fails
          patternRegistry.getHandler.mockReturnValue(vi.fn().mockResolvedValue(undefined));
          codec.decode.mockImplementation(() => {
            throw new Error('bad payload');
          });

          const msg = createMock<JsMsg>({
            subject: faker.lorem.word(),
            data: new Uint8Array([0xff]),
          });

          // When: message arrives
          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: terminated, handler NOT called
          expect(msg.term).toHaveBeenCalled();
          expect(msg.ack).not.toHaveBeenCalled();
        });
      });

      describe('when handler throws', () => {
        it('should nak the message for redelivery', async () => {
          // Given: handler that throws
          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createMock<JsMsg>({
            subject: faker.lorem.word(),
            data: new TextEncoder().encode(JSON.stringify({})),
          });

          // When: message arrives
          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: message nak'd (not term'd) for redelivery
          expect(msg.nak).toHaveBeenCalled();
          expect(msg.ack).not.toHaveBeenCalled();
          expect(msg.term).not.toHaveBeenCalled();
        });
      });
    });

    describe('broadcast stream', () => {
      describe('when broadcast message arrives', () => {
        it('should handle through the same pipeline', async () => {
          // Given: a handler for the broadcast subject
          const handler = vi.fn().mockResolvedValue(undefined);

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createMock<JsMsg>({
            subject: 'broadcast.config.updated',
            data: new TextEncoder().encode(JSON.stringify({ key: 'value' })),
          });

          // When: broadcast message arrives
          broadcasts$.next(msg);
          await new Promise(process.nextTick);

          // Then: handled and acked
          expect(handler).toHaveBeenCalled();
          expect(msg.ack).toHaveBeenCalled();
        });
      });
    });

    describe('handler-controlled retry', () => {
      it('should nak when handler calls ctx.retry()', async () => {
        // Given: handler that requests retry
        const handler = vi.fn().mockImplementation((_data: unknown, ctx: RpcContext) => {
          ctx.retry();
        });

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createMock<JsMsg>({
          ack: vi.fn(),
          subject: faker.lorem.word(),
          data: new TextEncoder().encode(JSON.stringify({})),
        });

        // When: message arrives
        events$.next(msg);
        await new Promise(process.nextTick);

        // Then: message nak'd, not acked
        expect(msg.nak).toHaveBeenCalledWith(undefined);
        expect(msg.ack).not.toHaveBeenCalled();
        expect(msg.term).not.toHaveBeenCalled();
      });

      it('should nak with delay when handler calls ctx.retry({ delayMs })', async () => {
        // Given: handler that requests delayed retry
        const handler = vi.fn().mockImplementation((_data: unknown, ctx: RpcContext) => {
          ctx.retry({ delayMs: 5_000 });
        });

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createMock<JsMsg>({
          ack: vi.fn(),
          subject: faker.lorem.word(),
          data: new TextEncoder().encode(JSON.stringify({})),
        });

        // When: message arrives
        events$.next(msg);
        await new Promise(process.nextTick);

        // Then: message nak'd with delay
        expect(msg.nak).toHaveBeenCalledWith(5_000);
        expect(msg.ack).not.toHaveBeenCalled();
      });
    });

    describe('handler-controlled terminate', () => {
      it('should term when handler calls ctx.terminate()', async () => {
        // Given: handler that terminates the message
        const handler = vi.fn().mockImplementation((_data: unknown, ctx: RpcContext) => {
          ctx.terminate();
        });

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createMock<JsMsg>({
          ack: vi.fn(),
          subject: faker.lorem.word(),
          data: new TextEncoder().encode(JSON.stringify({})),
        });

        // When: message arrives
        events$.next(msg);
        await new Promise(process.nextTick);

        // Then: message terminated, not acked
        expect(msg.term).toHaveBeenCalledWith(undefined);
        expect(msg.ack).not.toHaveBeenCalled();
        expect(msg.nak).not.toHaveBeenCalled();
      });

      it('should term with reason when handler calls ctx.terminate(reason)', async () => {
        // Given: handler that terminates with reason
        const reason = 'Order already cancelled';
        const handler = vi.fn().mockImplementation((_data: unknown, ctx: RpcContext) => {
          ctx.terminate(reason);
        });

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createMock<JsMsg>({
          ack: vi.fn(),
          subject: faker.lorem.word(),
          data: new TextEncoder().encode(JSON.stringify({})),
        });

        // When: message arrives
        events$.next(msg);
        await new Promise(process.nextTick);

        // Then: message terminated with reason
        expect(msg.term).toHaveBeenCalledWith(reason);
      });
    });

    describe('mutual exclusivity in handler', () => {
      it('should nak when handler calls both retry() and terminate()', async () => {
        // Given: handler that calls retry then terminate (terminate throws)
        const handler = vi.fn().mockImplementation((_data: unknown, ctx: RpcContext) => {
          ctx.retry();
          ctx.terminate(); // throws — becomes handler error → nak
        });

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createMock<JsMsg>({
          ack: vi.fn(),
          subject: faker.lorem.word(),
          data: new TextEncoder().encode(JSON.stringify({})),
        });

        // When: message arrives
        events$.next(msg);
        await new Promise(process.nextTick);

        // Then: treated as handler error — nak'd for retry
        expect(msg.nak).toHaveBeenCalled();
        expect(msg.ack).not.toHaveBeenCalled();
      });
    });
  });

  describe('HandlerCompleted emission', () => {
    beforeEach(() => {
      // Snapshot hooks are read at subscribeToStream() time, so configure the
      // mock and (re)start sut here — the outer beforeEach already started one
      // pass without HandlerCompleted enabled.
      sut.destroy();
      eventBus.hasHook.mockImplementation(
        (event) =>
          event === TransportEvent.HandlerCompleted || event === TransportEvent.MessageRouted,
      );
      sut.start();
    });

    const setupAndDispatch = async (handler: ReturnType<typeof vi.fn>): Promise<JsMsg> => {
      patternRegistry.getHandler.mockReturnValue(
        handler as unknown as ReturnType<typeof patternRegistry.getHandler>,
      );
      patternRegistry.resolveDeclared.mockReturnValue({
        pattern: 'orders.created',
        kind: StreamKind.Event,
      });

      // `ack: vi.fn()` is required to make `'ack' in msg` true so RpcContext
      // recognises the message as JetStream and ctx.retry()/terminate() work.
      const msg = createMock<JsMsg>({
        subject: `svc__microservice.ev.orders.created`,
        data: new TextEncoder().encode(JSON.stringify({})),
        ack: vi.fn(),
      });

      events$.next(msg);
      await new Promise(process.nextTick);

      return msg;
    };

    const handlerCompletedCalls = (): unknown[][] =>
      eventBus.emit.mock.calls.filter((c) => c[0] === TransportEvent.HandlerCompleted);

    it('should emit HandlerCompleted with success status when handler resolves', async () => {
      // Given/When
      const handler = vi.fn().mockResolvedValue(undefined);

      await setupAndDispatch(handler);

      // Then
      const calls = handlerCompletedCalls();

      expect(calls).toHaveLength(1);
      const firstCall = calls[0]!;

      expect(firstCall[1]).toBe('orders.created');
      expect(firstCall[2]).toBe(StreamKind.Event);
      expect(typeof firstCall[3]).toBe('number');
      expect(firstCall[3] as number).toBeGreaterThanOrEqual(0);
      expect(firstCall[4]).toBe('success');
    });

    it('should emit HandlerCompleted with error status when handler rejects', async () => {
      // Given/When
      const handler = vi.fn().mockRejectedValue(new Error('boom'));

      await setupAndDispatch(handler);

      // Then
      const calls = handlerCompletedCalls();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[4]).toBe('error');
    });

    it('should emit HandlerCompleted with retried status when handler calls ctx.retry()', async () => {
      // Given/When
      const handler = vi.fn().mockImplementation((_d: unknown, ctx: RpcContext) => {
        ctx.retry();
      });

      await setupAndDispatch(handler);

      // Then
      const calls = handlerCompletedCalls();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[4]).toBe('retried');
    });

    it('should emit HandlerCompleted with terminated status when handler calls ctx.terminate()', async () => {
      // Given/When
      const handler = vi.fn().mockImplementation((_d: unknown, ctx: RpcContext) => {
        ctx.terminate();
      });

      await setupAndDispatch(handler);

      // Then
      const calls = handlerCompletedCalls();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[4]).toBe('terminated');
    });

    it('should fall back to msg.subject + EventRouter kind when pattern is not declared', async () => {
      // Given: handler exists but pattern registry has no declared entry
      const handler = vi.fn().mockResolvedValue(undefined);

      patternRegistry.getHandler.mockReturnValue(handler);
      patternRegistry.resolveDeclared.mockReturnValue(null);

      const msg = createMock<JsMsg>({
        subject: 'unmatched.subject',
        data: new TextEncoder().encode(JSON.stringify({})),
      });

      // When
      events$.next(msg);
      await new Promise(process.nextTick);

      // Then
      const calls = handlerCompletedCalls();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toBe('unmatched.subject');
      expect(calls[0]?.[2]).toBe(StreamKind.Event);
    });

    it('should skip emission entirely when no listener is registered (hot-path guard)', async () => {
      // Given: rebuild sut with no hooks registered
      sut.destroy();
      eventBus.hasHook.mockReturnValue(false);
      sut.start();
      const handler = vi.fn().mockResolvedValue(undefined);

      patternRegistry.getHandler.mockReturnValue(handler);

      const msg = createMock<JsMsg>({
        subject: 'svc__microservice.ev.orders.created',
        data: new TextEncoder().encode(JSON.stringify({})),
      });

      // When
      events$.next(msg);
      await new Promise(process.nextTick);

      // Then: no HandlerCompleted emission AND no resolveDeclared lookup
      expect(handlerCompletedCalls()).toHaveLength(0);
      expect(patternRegistry.resolveDeclared).not.toHaveBeenCalled();
    });
  });

  describe('ordered message handling', () => {
    let ordered$: Subject<JsMsg>;

    beforeEach(() => {
      ordered$ = new Subject<JsMsg>();
      patternRegistry = createMock<PatternRegistry>();
      patternRegistry.hasOrderedHandlers.mockReturnValue(true);
      messageProvider = createMock<MessageProvider>({
        events$: events$.asObservable(),
        broadcasts$: broadcasts$.asObservable(),
        ordered$: ordered$.asObservable(),
      });
      sut = new EventRouter(messageProvider, patternRegistry, codec, eventBus);
      sut.start();
    });

    describe('when ordered handler succeeds', () => {
      it('should NOT call ack (nats.js auto-acknowledges ordered consumers)', async () => {
        // Given: a handler that resolves
        const handler = vi.fn().mockResolvedValue(undefined);

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createMock<JsMsg>({
          subject: faker.lorem.word(),
          data: new TextEncoder().encode(JSON.stringify({ test: true })),
        });

        // When: ordered message arrives
        ordered$.next(msg);
        await new Promise(process.nextTick);

        // Then: handler called, NO ack/nak/term
        expect(handler).toHaveBeenCalled();
        expect(msg.ack).not.toHaveBeenCalled();
        expect(msg.nak).not.toHaveBeenCalled();
        expect(msg.term).not.toHaveBeenCalled();
      });
    });

    describe('when ordered handler throws', () => {
      it('should log error but NOT nak or term', async () => {
        // Given: a handler that throws
        const handler = vi.fn().mockRejectedValue(new Error('handler failed'));

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createMock<JsMsg>({
          subject: faker.lorem.word(),
          data: new TextEncoder().encode(JSON.stringify({ test: true })),
        });

        // When: ordered message arrives
        ordered$.next(msg);
        await new Promise(process.nextTick);

        // Then: no ack/nak/term — ordered consumers skip retry semantics
        expect(msg.ack).not.toHaveBeenCalled();
        expect(msg.nak).not.toHaveBeenCalled();
        expect(msg.term).not.toHaveBeenCalled();
      });
    });

    describe('when ordered handler throws synchronously', () => {
      it('should contain the throw and keep processing the stream', async () => {
        // Given: a handler that throws before returning a promise
        const handler = vi.fn().mockImplementation(() => {
          throw new Error('sync failure');
        });

        patternRegistry.getHandler.mockReturnValue(handler);

        const failing = createMock<JsMsg>({
          subject: 'first.ordered',
          data: new TextEncoder().encode(JSON.stringify({})),
        });
        const healthy = createMock<JsMsg>({
          subject: 'second.ordered',
          data: new TextEncoder().encode(JSON.stringify({})),
        });

        // When: both ordered messages arrive
        ordered$.next(failing);
        ordered$.next(healthy);
        await new Promise(process.nextTick);

        // Then: no settlement attempted, the stream stays alive
        expect(handler).toHaveBeenCalledTimes(2);
        expect(failing.nak).not.toHaveBeenCalled();
        expect(failing.term).not.toHaveBeenCalled();
      });
    });

    describe('when no handler is found for ordered message', () => {
      it('should NOT call term (ordered consumers are ephemeral)', async () => {
        // Given: no handler registered
        patternRegistry.getHandler.mockReturnValue(null);

        const msg = createMock<JsMsg>({
          subject: 'unknown.ordered.subject',
          data: new TextEncoder().encode(JSON.stringify({})),
        });

        // When: ordered message arrives
        ordered$.next(msg);
        await new Promise(process.nextTick);

        // Then: no term/nak
        expect(msg.term).not.toHaveBeenCalled();
        expect(msg.nak).not.toHaveBeenCalled();
      });
    });

    describe('when ordered handler calls ctx.retry()', () => {
      it('should NOT retry (ordered consumers auto-acknowledge)', async () => {
        // Given: handler that requests retry on an ordered message
        const handler = vi.fn().mockImplementation((_data: unknown, ctx: RpcContext) => {
          ctx.retry();
        });

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createMock<JsMsg>({
          ack: vi.fn(),
          subject: faker.lorem.word(),
          data: new TextEncoder().encode(JSON.stringify({})),
        });

        // When: ordered message arrives
        ordered$.next(msg);
        await new Promise(process.nextTick);

        // Then: no nak/term — retry() is ignored for ordered consumers
        expect(msg.nak).not.toHaveBeenCalled();
        expect(msg.term).not.toHaveBeenCalled();
        expect(msg.ack).not.toHaveBeenCalled();
      });
    });

    describe('when ordered handler calls ctx.terminate()', () => {
      it('should NOT terminate (ordered consumers auto-acknowledge)', async () => {
        // Given: handler that requests terminate on an ordered message
        const handler = vi.fn().mockImplementation((_data: unknown, ctx: RpcContext) => {
          ctx.terminate();
        });

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createMock<JsMsg>({
          ack: vi.fn(),
          subject: faker.lorem.word(),
          data: new TextEncoder().encode(JSON.stringify({})),
        });

        // When: ordered message arrives
        ordered$.next(msg);
        await new Promise(process.nextTick);

        // Then: no term/nak — terminate() is ignored for ordered consumers
        expect(msg.term).not.toHaveBeenCalled();
        expect(msg.nak).not.toHaveBeenCalled();
        expect(msg.ack).not.toHaveBeenCalled();
      });
    });

    describe('when decode fails for ordered message', () => {
      it('should skip without ack/nak/term', async () => {
        // Given: handler exists but decode throws
        patternRegistry.getHandler.mockReturnValue(vi.fn().mockResolvedValue(undefined));
        codec.decode.mockImplementation(() => {
          throw new Error('bad payload');
        });

        const msg = createMock<JsMsg>({
          subject: faker.lorem.word(),
          data: new Uint8Array([0xff]),
        });

        // When: ordered message arrives
        ordered$.next(msg);
        await new Promise(process.nextTick);

        // Then: no ack/nak/term
        expect(msg.ack).not.toHaveBeenCalled();
        expect(msg.nak).not.toHaveBeenCalled();
        expect(msg.term).not.toHaveBeenCalled();
      });
    });
  });

  describe('dead letter handling', () => {
    const streamName = 'test-stream';
    const maxDeliverByStream = new Map<string, number>([[streamName, 3]]);
    let onDeadLetter: Mock;
    let deadLetterConfig: DeadLetterConfig;

    beforeEach(() => {
      onDeadLetter = vi.fn().mockResolvedValue(undefined);
      deadLetterConfig = { maxDeliverByStream, onDeadLetter };

      sut = new EventRouter(messageProvider, patternRegistry, codec, eventBus, deadLetterConfig);
      sut.start();
    });

    const createDeadLetterMsg = (overrides?: Partial<DeliveryInfo>): JsMsg =>
      createMock<JsMsg>({
        subject: 'test.subject',
        data: new TextEncoder().encode(JSON.stringify({ key: 'value' })),
        info: {
          deliveryCount: 3,
          stream: streamName,
          streamSequence: 42,
          redelivered: true,
          timestampNanos: Date.now() * 1_000_000,
          ...overrides,
        } as DeliveryInfo,
      });

    describe('happy path', () => {
      it('should call onDeadLetter and term when deliveryCount reaches maxDeliver', async () => {
        // Given: a handler that always fails
        const handler = vi.fn().mockRejectedValue(new Error('handler error'));

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createDeadLetterMsg();

        // When: message arrives at final delivery
        events$.next(msg);
        await new Promise(process.nextTick);

        // Then: onDeadLetter called with correct info, message terminated
        expect(onDeadLetter).toHaveBeenCalledWith(
          expect.objectContaining({
            subject: 'test.subject',
            data: { key: 'value' },
            error: expect.any(Error),
            deliveryCount: 3,
            stream: streamName,
            streamSequence: 42,
          }),
        );
        expect(msg.term).toHaveBeenCalled();
        expect(msg.nak).not.toHaveBeenCalled();
      });

      it('should emit TransportEvent.DeadLetter for observability', async () => {
        // Given: a handler that always fails
        const handler = vi.fn().mockRejectedValue(new Error('handler error'));

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createDeadLetterMsg();

        // When: dead letter detected
        events$.next(msg);
        await new Promise(process.nextTick);

        // Then: event emitted
        expect(eventBus.emit).toHaveBeenCalledWith(
          TransportEvent.DeadLetter,
          expect.objectContaining({ subject: 'test.subject' }),
        );
      });
    });

    describe('edge cases', () => {
      it('should nak normally when deliveryCount has not reached maxDeliver', async () => {
        // Given: a handler that fails, but not at max delivery
        const handler = vi.fn().mockRejectedValue(new Error('handler error'));

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createDeadLetterMsg({ deliveryCount: 1, redelivered: false });

        // When: message arrives at first delivery
        events$.next(msg);
        await new Promise(process.nextTick);

        // Then: regular nak, no dead letter
        expect(onDeadLetter).not.toHaveBeenCalled();
        expect(msg.nak).toHaveBeenCalled();
        expect(msg.term).not.toHaveBeenCalled();
      });

      it('should nak normally when stream is not in maxDeliverByStream map', async () => {
        // Given: message from an unknown stream
        const handler = vi.fn().mockRejectedValue(new Error('handler error'));

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createMock<JsMsg>({
          subject: 'unknown.subject',
          data: new TextEncoder().encode(JSON.stringify({})),
          info: {
            deliveryCount: 99,
            stream: 'unknown-stream',
            streamSequence: 1,
            redelivered: true,
            timestampNanos: Date.now() * 1_000_000,
          } as DeliveryInfo,
        });

        // When: message arrives
        events$.next(msg);
        await new Promise(process.nextTick);

        // Then: regular nak, no dead letter
        expect(onDeadLetter).not.toHaveBeenCalled();
        expect(msg.nak).toHaveBeenCalled();
      });
    });

    describe('error paths', () => {
      it('should nak the message if onDeadLetter throws', async () => {
        // Given: dead letter hook that fails (e.g. Redis/Postgres down)
        onDeadLetter.mockRejectedValue(new Error('DLQ persistence failed'));

        const handler = vi.fn().mockRejectedValue(new Error('handler error'));

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg = createDeadLetterMsg();

        // When: dead letter detected, hook fails
        events$.next(msg);
        await new Promise(process.nextTick);

        // Then: nak for retry instead of term
        expect(msg.nak).toHaveBeenCalled();
        expect(msg.term).not.toHaveBeenCalled();
      });
    });

    describe('publishToDlq (options.dlq enabled)', () => {
      const streamName = 'test-stream';
      const maxDeliverByStream = new Map<string, number>([[streamName, 3]]);
      let onDeadLetter: Mock;
      let deadLetterConfig: DeadLetterConfig;
      let connection: Mocked<ConnectionProvider>;
      let mockJs: { publish: ReturnType<typeof vi.fn> };

      beforeEach(() => {
        // Destroy the parent 'dead letter handling' sut (no dlq) started in the
        // outer beforeEach so it doesn't also process messages sent in these tests.
        sut.destroy();

        onDeadLetter = vi.fn().mockResolvedValue(undefined);
        deadLetterConfig = { maxDeliverByStream, onDeadLetter };
        mockJs = { publish: vi.fn().mockResolvedValue(undefined) };
        connection = createMock<ConnectionProvider>({
          getJetStreamClient: vi.fn().mockReturnValue(mockJs),
        });
      });

      const createDeadLetterMsg = (overrides?: Partial<DeliveryInfo>): JsMsg =>
        createMock<JsMsg>({
          subject: 'test.subject',
          data: new TextEncoder().encode(JSON.stringify({ key: 'value' })),
          headers: undefined,
          info: {
            deliveryCount: 3,
            stream: streamName,
            streamSequence: 42,
            redelivered: true,
            timestampNanos: Date.now() * 1_000_000,
            ...overrides,
          } as DeliveryInfo,
        });

      describe('when options.dlq is set — happy path (publish succeeds)', () => {
        it('should publish to DLQ stream, call onDeadLetter, and term the message', async () => {
          // Given: a DLQ-enabled router with a working connection
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: {},
          };

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          // When: message arrives at max delivery
          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: published to DLQ, callback notified, message terminated
          expect(mockJs.publish).toHaveBeenCalled();

          const publishCall = mockJs.publish.mock.calls[0]!;

          expect(publishCall[0]).toBe(dlqStreamName(options.name!));
          expect(publishCall[2].headers.get(JetstreamDlqHeader.DeadLetterReason)).toBe(
            'handler error',
          );

          expect(onDeadLetter).toHaveBeenCalled();
          expect(mockJs.publish.mock.invocationCallOrder[0]!).toBeLessThan(
            onDeadLetter.mock.invocationCallOrder[0]!,
          );

          expect(msg.term).toHaveBeenCalledWith('Moved to DLQ stream');
          expect(msg.nak).not.toHaveBeenCalled();
        });

        it('should forward original message headers to the DLQ publish', async () => {
          // Given: message with headers
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: {},
          };

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          // Create a msg with mock headers
          const mockHeaders = new Map([['X-Trace-Id', ['abc123']]]);
          const msg = createMock<JsMsg>({
            subject: 'test.subject',
            data: new TextEncoder().encode(JSON.stringify({ key: 'value' })),
            headers: mockHeaders as unknown as JsMsg['headers'],
            info: {
              deliveryCount: 3,
              stream: streamName,
              streamSequence: 42,
              redelivered: true,
              timestampNanos: Date.now() * 1_000_000,
            } as DeliveryInfo,
          });

          // When: dead-letter message arrives
          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: publish was called
          expect(mockJs.publish).toHaveBeenCalled();

          const publishCall = mockJs.publish.mock.calls[0]!;

          expect(publishCall[0]).toBe(dlqStreamName(options.name!));
          expect(publishCall[2].headers.get('X-Trace-Id')).toBe('abc123');
          expect(publishCall[2].headers.get(JetstreamDlqHeader.DeadLetterReason)).toBe(
            'handler error',
          );
          expect(publishCall[2].headers.get(JetstreamDlqHeader.OriginalSubject)).toBe(
            'test.subject',
          );

          expect(msg.term).toHaveBeenCalledWith('Moved to DLQ stream');
        });

        it('should strip NATS control headers from the DLQ republish', async () => {
          // Given: a message that carries server control headers from the
          // original publish (per-message TTL, dedup id)
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: {},
          };

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const mockHeaders = new Map([
            ['Nats-TTL', ['30s']],
            ['Nats-Msg-Id', ['original-id']],
            ['X-Trace-Id', ['abc123']],
          ]);
          const msg = createMock<JsMsg>({
            subject: 'test.subject',
            data: new TextEncoder().encode(JSON.stringify({ key: 'value' })),
            headers: mockHeaders as unknown as JsMsg['headers'],
            info: {
              deliveryCount: 3,
              stream: streamName,
              streamSequence: 42,
              redelivered: true,
              timestampNanos: Date.now() * 1_000_000,
            } as DeliveryInfo,
          });

          // When: dead-letter message arrives
          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: control headers are gone (a copied Nats-TTL would expire the
          // DLQ entry or get the publish rejected), diagnostics are preserved
          const publishCall = mockJs.publish.mock.calls[0]!;
          const dlqHeaders = publishCall[2].headers;

          expect(dlqHeaders.get('Nats-TTL')).toBe('');
          expect(dlqHeaders.get('Nats-Msg-Id')).toBe('');
          expect(dlqHeaders.get('X-Trace-Id')).toBe('abc123');
          expect(msg.term).toHaveBeenCalledWith('Moved to DLQ stream');
        });

        it('should use error.message as reason for Error instances', async () => {
          // Given: handler throws a proper Error
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: {},
          };

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('specific failure'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: published (reason extracted from error.message)
          expect(mockJs.publish).toHaveBeenCalled();

          const publishCall = mockJs.publish.mock.calls[0]!;

          expect(publishCall[0]).toBe(dlqStreamName(options.name!));
          expect(publishCall[2].headers.get(JetstreamDlqHeader.DeadLetterReason)).toBe(
            'specific failure',
          );

          expect(msg.term).toHaveBeenCalledWith('Moved to DLQ stream');
        });

        it('should handle non-Error object errors by reading .message property', async () => {
          // Given: handler throws a plain object with a message property
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: {},
          };

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue({ message: 'object error' });

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: published (reason extracted from .message)
          expect(mockJs.publish).toHaveBeenCalled();

          const publishCall = mockJs.publish.mock.calls[0]!;

          expect(publishCall[0]).toBe(dlqStreamName(options.name!));
          expect(publishCall[2].headers.get(JetstreamDlqHeader.DeadLetterReason)).toBe(
            'object error',
          );

          expect(msg.term).toHaveBeenCalledWith('Moved to DLQ stream');
        });

        it('should still term when onDeadLetter callback throws after successful DLQ publish', async () => {
          // Given: DLQ publish succeeds but onDeadLetter hook fails
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: {},
          };

          onDeadLetter.mockRejectedValue(new Error('hook failed'));

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: message is still terminated (hook failure doesn't stop DLQ flow)
          expect(mockJs.publish).toHaveBeenCalled();

          const publishCall = mockJs.publish.mock.calls[0]!;

          expect(publishCall[0]).toBe(dlqStreamName(options.name!));
          expect(publishCall[2].headers.get(JetstreamDlqHeader.DeadLetterReason)).toBe(
            'handler error',
          );

          expect(onDeadLetter).toHaveBeenCalled();
          expect(mockJs.publish.mock.invocationCallOrder[0]!).toBeLessThan(
            onDeadLetter.mock.invocationCallOrder[0]!,
          );

          expect(msg.term).toHaveBeenCalledWith('Moved to DLQ stream');
          expect(msg.nak).not.toHaveBeenCalled();
        });
      });

      describe('when options.dlq is set — publish fails', () => {
        it('should nak and preserve the message in dlq-only mode (no callback to fall back to)', async () => {
          // Given: dlq-only configuration and a DLQ publish that never succeeds
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: {},
          };
          const dlqOnlyConfig: DeadLetterConfig = { maxDeliverByStream };

          mockJs.publish.mockRejectedValue(new Error('NATS down'));

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            dlqOnlyConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          // When: dead-letter message arrives and every capture attempt fails
          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: the message is released but never deleted
          expect(msg.nak).toHaveBeenCalled();
          expect(msg.term).not.toHaveBeenCalled();
        });

        it('should retry the DLQ publish before falling back', async () => {
          // Given: DLQ publish fails once, then succeeds
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: {},
          };

          mockJs.publish
            .mockRejectedValueOnce(new Error('transient NATS hiccup'))
            .mockResolvedValue(undefined);

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          // When: dead-letter message arrives
          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: second attempt landed the message in the DLQ — no fallback path
          expect(mockJs.publish).toHaveBeenCalledTimes(2);
          expect(msg.term).toHaveBeenCalledWith('Moved to DLQ stream');
          expect(msg.nak).not.toHaveBeenCalled();
        });

        it('should fall back to onDeadLetter callback and nak when DLQ publish throws', async () => {
          // Given: DLQ publish fails
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: {},
          };

          mockJs.publish.mockRejectedValue(new Error('NATS timeout'));

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: falls back — onDeadLetter was called, message term'd via fallback
          expect(onDeadLetter).toHaveBeenCalled();
          expect(msg.term).toHaveBeenCalledWith('Dead letter processed via fallback callback');
          expect(msg.nak).not.toHaveBeenCalled();
        });

        it('should nak when both DLQ publish and fallback onDeadLetter throw', async () => {
          // Given: DLQ publish fails AND fallback callback also fails
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: {},
          };

          mockJs.publish.mockRejectedValue(new Error('NATS timeout'));
          onDeadLetter.mockRejectedValue(new Error('DLQ persistence failed'));

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: last resort nak
          expect(msg.nak).toHaveBeenCalled();
          expect(msg.term).not.toHaveBeenCalled();
        });
      });

      describe('when router is constructed with NameResolver', () => {
        it('should publish to the DLQ stream name from the resolver', async () => {
          // Given: options with custom DLQ stream name via resolver
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: { stream: { name: 'resolver-dlq' } },
          };
          const names = new NameResolver(options);

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
            names,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: published to resolver's dlqStreamName()
          expect(mockJs.publish).toHaveBeenCalled();

          const publishCall = mockJs.publish.mock.calls[0]!;

          expect(publishCall[0]).toBe(names.dlqStreamName());
        });
      });

      describe('when options.dlq has a custom stream name', () => {
        it('should publish to the custom dlq stream name', async () => {
          // Given: DLQ with custom stream name
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: { stream: { name: 'my-custom-dlq' } },
          };

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: published to the CUSTOM DLQ name, not the convention name
          expect(mockJs.publish).toHaveBeenCalled();

          const publishCall = mockJs.publish.mock.calls[0]!;

          expect(publishCall[0]).toBe('my-custom-dlq');
        });
      });

      describe('when connection or service name is missing', () => {
        it('should fall back to onDeadLetter when connection is absent', async () => {
          // Given: no ConnectionProvider (options.dlq is set but connection=undefined)
          const options: JetstreamModuleOptions = {
            name: 'my-service',
            servers: ['nats://localhost:4222'],
            dlq: {},
          };

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            undefined, // no connection
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: falls back to onDeadLetter callback since it can't publish
          expect(onDeadLetter).toHaveBeenCalled();
          expect(msg.term).toHaveBeenCalledWith('Dead letter processed via fallback callback');
        });

        it('should fall back to onDeadLetter when service name is absent', async () => {
          // Given: options with no name (can't derive DLQ stream subject)
          const options: JetstreamModuleOptions = {
            name: '' as unknown as string,
            servers: ['nats://localhost:4222'],
            dlq: {},
          };

          sut = new EventRouter(
            messageProvider,
            patternRegistry,
            codec,
            eventBus,
            deadLetterConfig,
            undefined,
            undefined,
            connection,
            options,
          );
          sut.start();

          const handler = vi.fn().mockRejectedValue(new Error('handler error'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createDeadLetterMsg();

          events$.next(msg);
          await new Promise(process.nextTick);

          // Then: falls back to onDeadLetter callback
          expect(onDeadLetter).toHaveBeenCalled();
          expect(msg.term).toHaveBeenCalledWith('Dead letter processed via fallback callback');
        });
      });
    });
  });

  describe('error recovery', () => {
    describe('when handle() throws an unexpected error', () => {
      it('should catch via catchError and keep the subscription alive', async () => {
        sut.start();

        // Given: getHandler throws synchronously (unexpected)
        patternRegistry.getHandler.mockImplementation(() => {
          throw new Error('registry exploded');
        });

        const msg = createMock<JsMsg>({
          subject: 'test.subject',
          data: new TextEncoder().encode(JSON.stringify({})),
        });

        // When: message arrives
        events$.next(msg);
        await new Promise(process.nextTick);

        // Then: subscription is still alive (can process next message)
        const handler = vi.fn().mockResolvedValue(undefined);

        patternRegistry.getHandler.mockReturnValue(handler);

        const msg2 = createMock<JsMsg>({
          subject: 'test.subject',
          data: new TextEncoder().encode(JSON.stringify({ id: 1 })),
        });

        events$.next(msg2);
        await new Promise(process.nextTick);

        expect(handler).toHaveBeenCalled();
      });

      it('should not process messages more than once after an error', async () => {
        // Given: a handler that fails once then succeeds
        const handler = vi
          .fn()
          .mockRejectedValueOnce(new Error('transient'))
          .mockResolvedValue(undefined);

        patternRegistry.getHandler.mockReturnValue(handler);
        sut.start();

        // When: first message causes handler error (nak path)
        const msg1 = createMock<JsMsg>({
          subject: 'test.subject',
          data: new TextEncoder().encode(JSON.stringify({ n: 1 })),
        });

        events$.next(msg1);
        await new Promise(process.nextTick);
        expect(handler).toHaveBeenCalledTimes(1);

        // When: second message arrives
        handler.mockClear();

        const msg2 = createMock<JsMsg>({
          subject: 'test.subject',
          data: new TextEncoder().encode(JSON.stringify({ n: 2 })),
        });

        events$.next(msg2);
        await new Promise(process.nextTick);

        // Then: handler called exactly once for msg2 (no duplicate)
        expect(handler).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('concurrency control', () => {
    it('should limit parallel handler execution when concurrency is set', async () => {
      // Given: sut with concurrency = 1
      const processingConfig: EventProcessingConfig = { events: { concurrency: 1 } };

      sut = new EventRouter(
        messageProvider,
        patternRegistry,
        codec,
        eventBus,
        undefined,
        processingConfig,
      );
      sut.start();

      let concurrentCount = 0;
      let maxConcurrent = 0;

      const handler = vi.fn().mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((r) => setTimeout(r, 50));
        concurrentCount--;
      });

      patternRegistry.getHandler.mockReturnValue(handler);

      const msg1 = createMock<JsMsg>({
        subject: faker.lorem.word(),
        data: new TextEncoder().encode(JSON.stringify({ n: 1 })),
      });
      const msg2 = createMock<JsMsg>({
        subject: faker.lorem.word(),
        data: new TextEncoder().encode(JSON.stringify({ n: 2 })),
      });

      // When: two messages arrive simultaneously
      events$.next(msg1);
      events$.next(msg2);

      // Then: only one handler runs at a time
      await new Promise((r) => setTimeout(r, 200));

      expect(maxConcurrent).toBe(1);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should allow unlimited concurrency when no config is set', async () => {
      // Given: default sut (no processingConfig)
      sut.start();

      let concurrentCount = 0;
      let maxConcurrent = 0;

      const handler = vi.fn().mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((r) => setTimeout(r, 50));
        concurrentCount--;
      });

      patternRegistry.getHandler.mockReturnValue(handler);

      const msg1 = createMock<JsMsg>({
        subject: faker.lorem.word(),
        data: new TextEncoder().encode(JSON.stringify({ n: 1 })),
      });
      const msg2 = createMock<JsMsg>({
        subject: faker.lorem.word(),
        data: new TextEncoder().encode(JSON.stringify({ n: 2 })),
      });

      // When: two messages arrive simultaneously
      events$.next(msg1);
      events$.next(msg2);

      // Then: both handlers run in parallel
      await new Promise((r) => setTimeout(r, 200));

      expect(maxConcurrent).toBe(2);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('ack extension', () => {
    it('should call msg.working() periodically when ackExtension is a number', async () => {
      // Given: sut with ackExtension = 50ms
      sut = new EventRouter(messageProvider, patternRegistry, codec, eventBus, undefined, {
        events: { ackExtension: 50 },
      });
      sut.start();

      let resolveHandler!: () => void;
      const handlerPromise = new Promise<void>((r) => {
        resolveHandler = r;
      });
      const handler = vi.fn().mockReturnValue(handlerPromise);

      patternRegistry.getHandler.mockReturnValue(handler);

      const msg = createMock<JsMsg>({
        subject: faker.lorem.word(),
        data: new TextEncoder().encode(JSON.stringify({ test: true })),
      });

      // When: message arrives and handler is slow
      events$.next(msg);

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
      sut = new EventRouter(messageProvider, patternRegistry, codec, eventBus, undefined, {
        events: { ackExtension: 30 },
      });
      sut.start();

      const handler = vi.fn().mockResolvedValue(undefined);

      patternRegistry.getHandler.mockReturnValue(handler);

      const msg = createMock<JsMsg>({
        subject: faker.lorem.word(),
        data: new TextEncoder().encode(JSON.stringify({ test: true })),
      });

      // When: message arrives and handler completes quickly
      events$.next(msg);
      await new Promise((r) => setTimeout(r, 50));

      const countAfterDone = (msg.working as ReturnType<typeof vi.fn>).mock.calls.length;

      // Then: no additional working() calls after handler completes
      await new Promise((r) => setTimeout(r, 100));

      expect((msg.working as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countAfterDone);
    });

    it('should extend ack for backlogged messages while they wait for a slot', async () => {
      // Given: concurrency 1, the first handler hangs — the second message
      // parks in the backlog with its ack_wait clock running
      sut = new EventRouter(messageProvider, patternRegistry, codec, eventBus, undefined, {
        events: { concurrency: 1, ackExtension: 30 },
      });
      sut.start();

      let resolveHandler!: () => void;
      const handlerPromise = new Promise<void>((r) => {
        resolveHandler = r;
      });
      const handler = vi.fn().mockReturnValue(handlerPromise);

      patternRegistry.getHandler.mockReturnValue(handler);

      const inFlight = createMock<JsMsg>({
        subject: 'first.subject',
        data: new TextEncoder().encode(JSON.stringify({})),
      });
      const queued = createMock<JsMsg>({
        subject: 'second.subject',
        data: new TextEncoder().encode(JSON.stringify({})),
      });

      // When: the second message waits in the backlog
      events$.next(inFlight);
      events$.next(queued);
      await new Promise((r) => setTimeout(r, 120));

      // Then: the queued message kept its ack alive while waiting
      expect(queued.working).toHaveBeenCalled();

      resolveHandler();
      await new Promise((r) => setTimeout(r, 10));
    });

    it('should not call working() when ackExtension is disabled', async () => {
      // Given: default sut (no processingConfig)
      sut.start();

      const handler = vi.fn().mockResolvedValue(undefined);

      patternRegistry.getHandler.mockReturnValue(handler);

      const msg = createMock<JsMsg>({
        subject: faker.lorem.word(),
        data: new TextEncoder().encode(JSON.stringify({ test: true })),
      });

      // When: message arrives and is processed
      events$.next(msg);
      await new Promise((r) => setTimeout(r, 50));

      // Then: working() is never called
      expect(msg.working).not.toHaveBeenCalled();
    });

    it('should auto-calculate interval from ackWaitMap when ackExtension is true', async () => {
      // Given: sut with ackExtension = true and ackWaitMap with 200ms (in nanos) ack_wait
      const ackWaitNanos = 1_000 * 1_000_000; // 1000ms in nanoseconds
      const ackWaitMap = new Map<StreamKind, number>([[StreamKind.Event, ackWaitNanos]]);

      sut = new EventRouter(
        messageProvider,
        patternRegistry,
        codec,
        eventBus,
        undefined,
        { events: { ackExtension: true } },
        ackWaitMap,
      );
      sut.start();

      let resolveHandler!: () => void;
      const handlerPromise = new Promise<void>((r) => {
        resolveHandler = r;
      });
      const handler = vi.fn().mockReturnValue(handlerPromise);

      patternRegistry.getHandler.mockReturnValue(handler);

      const msg = createMock<JsMsg>({
        subject: faker.lorem.word(),
        data: new TextEncoder().encode(JSON.stringify({ test: true })),
      });

      // When: message arrives and handler is slow
      // Expected interval: max(1000ms / 2, 500) = 500ms
      events$.next(msg);
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
      sut = new EventRouter(messageProvider, patternRegistry, codec, eventBus, undefined, {
        events: { ackExtension: true },
      });
      sut.start();

      const handler = vi.fn().mockResolvedValue(undefined);

      patternRegistry.getHandler.mockReturnValue(handler);

      const msg = createMock<JsMsg>({
        subject: faker.lorem.word(),
        data: new TextEncoder().encode(JSON.stringify({ test: true })),
      });

      // When: message arrives and handler completes quickly
      events$.next(msg);
      await new Promise((r) => setTimeout(r, 50));

      // Then: no working() calls (5s interval > 50ms wait)
      // The fallback 5s interval means no call within the short window
      expect(msg.working).not.toHaveBeenCalled();
    });
  });
});
