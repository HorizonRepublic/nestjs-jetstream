import { createMock } from '@golevelup/ts-jest';
import { faker } from '@faker-js/faker';
import type { DeliveryInfo, JsMsg } from 'nats';
import { Subject } from 'rxjs';

import { EventBus } from '../../hooks';
import type { Codec } from '../../interfaces';
import { TransportEvent } from '../../interfaces';
import { MessageProvider } from '../infrastructure/message.provider';

import type { DeadLetterConfig } from './event.router';
import { EventRouter } from './event.router';
import { PatternRegistry } from './pattern-registry';

describe(EventRouter, () => {
  let sut: EventRouter;

  let messageProvider: jest.Mocked<MessageProvider>;
  let patternRegistry: jest.Mocked<PatternRegistry>;
  let codec: jest.Mocked<Codec>;
  let eventBus: jest.Mocked<EventBus>;

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
      decode: jest.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
    });
    eventBus = createMock<EventBus>();

    sut = new EventRouter(messageProvider, patternRegistry, codec, eventBus);
  });

  afterEach(jest.resetAllMocks);

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
          const handler = jest.fn().mockResolvedValue(undefined);

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
          patternRegistry.getHandler.mockReturnValue(jest.fn());
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
          const handler = jest.fn().mockRejectedValue(new Error('handler error'));

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
          const handler = jest.fn().mockResolvedValue(undefined);

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

  describe('dead letter handling', () => {
    const streamName = 'test-stream';
    const maxDeliverByStream = new Map<string, number>([[streamName, 3]]);
    let onDeadLetter: jest.Mock;
    let deadLetterConfig: DeadLetterConfig;

    beforeEach(() => {
      onDeadLetter = jest.fn().mockResolvedValue(undefined);
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
        const handler = jest.fn().mockRejectedValue(new Error('handler error'));

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
        const handler = jest.fn().mockRejectedValue(new Error('handler error'));

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
        const handler = jest.fn().mockRejectedValue(new Error('handler error'));

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
        const handler = jest.fn().mockRejectedValue(new Error('handler error'));

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

        const handler = jest.fn().mockRejectedValue(new Error('handler error'));

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
});
