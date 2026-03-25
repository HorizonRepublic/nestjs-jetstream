import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { DeliveryInfo, JsMsg } from 'nats';
import { Subject } from 'rxjs';

import { EventBus } from '../../hooks';
import type { Codec } from '../../interfaces';
import { TransportEvent } from '../../interfaces';
import { MessageProvider } from '../infrastructure';

import { StreamKind } from '../../interfaces';
import type { DeadLetterConfig, EventProcessingConfig } from '../../interfaces';
import { EventRouter } from './event.router';
import { PatternRegistry } from './pattern-registry';

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
          expect(eventBus.emit).toHaveBeenCalledWith(
            TransportEvent.MessageRouted,
            msg.subject,
            'event',
          );
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
        // Given: dead letter hook that fails
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
