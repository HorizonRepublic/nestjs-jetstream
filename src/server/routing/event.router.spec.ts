import { createMock } from '@golevelup/ts-jest';
import { faker } from '@faker-js/faker';
import type { JsMsg } from 'nats';
import { Subject } from 'rxjs';

import { EventBus } from '../../hooks';
import type { Codec } from '../../interfaces';
import { TransportEvent } from '../../interfaces';
import { MessageProvider } from '../infrastructure/message.provider';

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
});
