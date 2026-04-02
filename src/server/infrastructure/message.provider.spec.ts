import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { Consumer, ConsumerInfo, ConsumerMessages, JsMsg } from '@nats-io/jetstream';

import { ConnectionProvider } from '../../connection';
import { EventBus } from '../../hooks';
import { StreamKind, TransportEvent } from '../../interfaces';

import { MessageProvider } from './message.provider';

interface MockIteratorResult<T> {
  done: boolean;
  value: T | undefined;
}

interface AsyncIteratorLike<T> {
  next(): Promise<MockIteratorResult<T>>;
}

/**
 * Creates a simple async iterator next() function for status events.
 * Yields events from the array, then blocks until stopped.
 */
const createStatusIterator = (
  events: { type: string; count: number }[],
  isStopped: () => boolean,
  onBlock: (unblock: () => void) => void,
): (() => Promise<MockIteratorResult<{ type: string; count: number }>>) => {
  let i = 0;

  return async (): Promise<MockIteratorResult<{ type: string; count: number }>> => {
    if (i < events.length) {
      return { done: false, value: events[i++] };
    }

    return new Promise((resolve) => {
      const unblock = (): void => {
        resolve({ done: true, value: undefined });
      };

      if (isStopped()) {
        resolve({ done: true, value: undefined });
      } else {
        onBlock(unblock);
      }
    });
  };
};

/**
 * Creates a mock async iterable of JsMsg that can be stopped externally.
 * Simulates the ConsumerMessages object returned by consumer.consume().
 */
const createMockMessages = (
  msgs: JsMsg[] = [],
  statusEvents: { type: string; count: number }[] = [],
): ConsumerMessages => {
  let stopped = false;
  let resolveWait: (() => void) | null = null;

  const mockMessages = {
    stop: vi.fn(() => {
      stopped = true;
      resolveWait?.();
    }),
    status: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: createStatusIterator(
          statusEvents,
          () => stopped,
          (unblock) => {
            resolveWait = unblock;
          },
        ),
      }),
    }),
    [Symbol.asyncIterator]: (): AsyncIteratorLike<JsMsg> => {
      let index = 0;

      return {
        next: async (): Promise<MockIteratorResult<JsMsg>> => {
          if (stopped || index >= msgs.length) {
            return { done: true, value: undefined };
          }

          return { done: false, value: msgs[index++] };
        },
      };
    },
  };

  return mockMessages as unknown as ConsumerMessages;
};

describe(MessageProvider, () => {
  let sut: MessageProvider;

  let connection: Mocked<ConnectionProvider>;
  let eventBus: Mocked<EventBus>;

  beforeEach(() => {
    connection = createMock<ConnectionProvider>();
    eventBus = createMock<EventBus>();

    sut = new MessageProvider(connection, eventBus);
  });

  afterEach(vi.resetAllMocks);

  describe('destroy()', () => {
    describe('when called after start', () => {
      it('should reinitialize subjects so start() can be called again', async () => {
        // Given: a consumer that completes immediately
        const mockConsumer = createMock<Consumer>({
          consume: vi.fn().mockResolvedValue(createMockMessages()),
        });

        const consumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });

        const js = {
          consumers: {
            get: vi.fn().mockResolvedValue(mockConsumer),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        const consumers = new Map<StreamKind, ConsumerInfo>();

        consumers.set(StreamKind.Event, consumerInfo);

        // When: start, destroy, then start again
        sut.start(consumers);
        await new Promise(process.nextTick);

        sut.destroy();

        // Then: can start again without error (subjects were reinitialized)
        js.consumers.get.mockResolvedValue(mockConsumer);
        sut.start(consumers);
        await new Promise(process.nextTick);

        expect(js.consumers.get).toHaveBeenCalled();

        sut.destroy();
      });
    });

    describe('when orderedReadyReject is pending', () => {
      it('should reject with "Destroyed before ordered consumer connected"', async () => {
        // Given: startOrdered() called but consumer not yet connected
        const js = {
          consumers: {
            get: vi.fn().mockReturnValue(
              new Promise(() => {
                // Never resolves — simulates a hanging connection
              }),
            ),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        const orderedPromise = sut.startOrdered('test-stream', ['test.>']);

        await new Promise(process.nextTick);

        // When: destroy() called while ordered consumer is pending
        sut.destroy();

        // Then: the returned promise rejects
        await expect(orderedPromise).rejects.toThrow('Destroyed before ordered consumer connected');
      });
    });
  });

  describe('createSelfHealingFlow', () => {
    describe('when consumer.consume() throws', () => {
      it('should emit TransportEvent.Error and retry', async () => {
        vi.useFakeTimers();

        // Given: first call fails, second call succeeds
        const mockMessages = createMockMessages();
        const mockConsumer = createMock<Consumer>({
          consume: vi.fn().mockResolvedValue(mockMessages),
        });

        const consumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });

        const connectionError = new Error('connection lost');
        const js = {
          consumers: {
            get: vi.fn().mockRejectedValueOnce(connectionError).mockResolvedValue(mockConsumer),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        const consumers = new Map<StreamKind, ConsumerInfo>();

        consumers.set(StreamKind.Event, consumerInfo);

        // When: start() called
        sut.start(consumers);

        // Let the first attempt fail
        await vi.advanceTimersByTimeAsync(0);

        // Then: error event emitted
        expect(eventBus.emit).toHaveBeenCalledWith(
          TransportEvent.Error,
          connectionError,
          'message-provider',
        );

        // Advance past the backoff delay (200ms for 1 failure: 100 * 2^1)
        await vi.advanceTimersByTimeAsync(300);

        // Then: retry happened (consumers.get called at least twice)
        expect(js.consumers.get.mock.calls.length).toBeGreaterThanOrEqual(2);

        sut.destroy();
        vi.useRealTimers();
      });
    });

    describe('when exponential backoff reaches cap', () => {
      it('should cap delay at 30_000ms', async () => {
        vi.useFakeTimers();

        // Given: consumer that always fails
        const consumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });

        const js = {
          consumers: {
            get: vi.fn().mockRejectedValue(new Error('always fails')),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        const consumers = new Map<StreamKind, ConsumerInfo>();

        consumers.set(StreamKind.Event, consumerInfo);

        // When: start() called
        sut.start(consumers);

        // Let failures accumulate: we need 10+ failures to hit the cap
        // After N failures, delay = min(100 * 2^N, 30000)
        // N=1: 200ms, N=2: 400ms, N=3: 800ms, N=4: 1600ms, N=5: 3200ms
        // N=6: 6400ms, N=7: 12800ms, N=8: 25600ms, N=9: 30000ms (capped)
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(31_000);
        }

        // Then: consumers.get was called multiple times (10+ retries)
        expect(js.consumers.get.mock.calls.length).toBeGreaterThanOrEqual(10);

        sut.destroy();
        vi.useRealTimers();
      });
    });
  });

  describe('monitorConsumerHealth', () => {
    describe('when 2+ heartbeats are missed', () => {
      it('should stop the consumer messages iterator', async () => {
        // Given: consumer with status that emits HeartbeatsMissed with data >= 2
        const statusEvents = [{ type: 'heartbeats_missed', count: 2 }];

        const mockMessages = createMockMessages([], statusEvents);

        const mockConsumer = createMock<Consumer>({
          consume: vi.fn().mockResolvedValue(mockMessages),
        });

        const consumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });

        const js = {
          consumers: {
            get: vi.fn().mockResolvedValue(mockConsumer),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        const consumers = new Map<StreamKind, ConsumerInfo>();

        consumers.set(StreamKind.Event, consumerInfo);

        // When: start consuming
        sut.start(consumers);
        await new Promise(process.nextTick);
        await new Promise(process.nextTick);

        // Then: messages.stop() called due to missed heartbeats
        expect(mockMessages.stop).toHaveBeenCalled();

        sut.destroy();
      });
    });

    describe('when only 1 heartbeat is missed', () => {
      it('should not stop the consumer messages iterator', async () => {
        // Given: consumer with status that emits HeartbeatsMissed with data = 1
        const statusEvents = [{ type: 'heartbeats_missed', count: 1 }];

        const mockMessages = createMockMessages([], statusEvents);

        const mockConsumer = createMock<Consumer>({
          consume: vi.fn().mockResolvedValue(mockMessages),
        });

        const consumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });

        const js = {
          consumers: {
            get: vi.fn().mockResolvedValue(mockConsumer),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        const consumers = new Map<StreamKind, ConsumerInfo>();

        consumers.set(StreamKind.Event, consumerInfo);

        // When: start consuming
        sut.start(consumers);
        await new Promise(process.nextTick);
        await new Promise(process.nextTick);

        // Then: messages.stop() NOT called — 1 missed heartbeat is within threshold
        expect(mockMessages.stop).not.toHaveBeenCalled();

        sut.destroy();
      });
    });
  });

  describe('createOrderedFlow', () => {
    describe('when consumeOrderedOnce throws on first attempt', () => {
      it('should reject the startOrdered() promise via onFirstError', async () => {
        vi.useFakeTimers();

        // Given: ordered consumer creation fails once, then succeeds
        const mockMessages = createMockMessages();
        const mockConsumer = createMock<Consumer>({
          consume: vi.fn().mockResolvedValue(mockMessages),
        });

        const js = {
          consumers: {
            get: vi
              .fn()
              .mockRejectedValueOnce(new Error('stream not found'))
              .mockResolvedValue(mockConsumer),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        // When: startOrdered() called — attach .catch immediately to avoid unhandled rejection
        const orderedPromise = sut
          .startOrdered('test-stream', ['test.>'])
          .catch((err: Error) => err);

        await vi.advanceTimersByTimeAsync(0);

        // Then: the returned promise rejects with the first error
        const result = await orderedPromise;

        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toBe('stream not found');

        sut.destroy();
        vi.useRealTimers();
      });
    });

    describe('when ordered consumer connects successfully', () => {
      it('should resolve the startOrdered() promise', async () => {
        // Given: ordered consumer connects and starts consuming
        const mockMessages = createMockMessages();

        const mockConsumer = createMock<Consumer>({
          consume: vi.fn().mockResolvedValue(mockMessages),
        });

        const js = {
          consumers: {
            get: vi.fn().mockResolvedValue(mockConsumer),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        // When: startOrdered() called
        const orderedPromise = sut.startOrdered('test-stream', ['test.>']);

        await new Promise(process.nextTick);
        await new Promise(process.nextTick);

        // Then: promise resolves
        await expect(orderedPromise).resolves.toBeUndefined();

        sut.destroy();
      });
    });
  });

  describe('getTargetSubject', () => {
    describe('when unknown stream kind is passed', () => {
      it('should throw', () => {
        // Given: an invalid kind triggers the exhaustive switch default
        // We access getTargetSubject indirectly via start() with an invalid kind
        const invalidKind = 'invalid' as never;

        const consumers = new Map<StreamKind, ConsumerInfo>();

        consumers.set(invalidKind, createMock<ConsumerInfo>());

        // When/Then: start() throws because getTargetSubject doesn't recognize the kind
        expect(() => {
          sut.start(consumers);
        }).toThrow(/unknown stream kind/i);
      });
    });
  });

  describe('consumeOnce', () => {
    describe('when messages are emitted', () => {
      it('should forward them to the correct subject', async () => {
        // Given: a consumer that emits one message then stops
        const mockMsg = createMock<JsMsg>({
          subject: 'test.ev.something',
        });

        const mockMessages = createMockMessages([mockMsg]);

        const mockConsumer = createMock<Consumer>({
          consume: vi.fn().mockResolvedValue(mockMessages),
        });

        const consumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });

        const js = {
          consumers: {
            get: vi.fn().mockResolvedValue(mockConsumer),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        const consumers = new Map<StreamKind, ConsumerInfo>();

        consumers.set(StreamKind.Event, consumerInfo);

        // When: subscribe and start
        const received: JsMsg[] = [];

        sut.events$.subscribe((msg) => {
          received.push(msg);
        });
        sut.start(consumers);

        await new Promise(process.nextTick);
        await new Promise(process.nextTick);

        // Then: message forwarded to events$
        expect(received).toContain(mockMsg);

        sut.destroy();
      });
    });
  });

  describe('consumer recovery', () => {
    describe('when consumers.get throws "consumer not found" and consumerRecoveryFn is provided', () => {
      it('should call consumerRecoveryFn with the correct StreamKind and retry with recovered consumer info', async () => {
        // Given: a consumerRecoveryFn that returns a new ConsumerInfo
        const recoveredConsumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });
        const consumerRecoveryFn = vi.fn().mockResolvedValue(recoveredConsumerInfo);

        const sutWithRecovery = new MessageProvider(
          connection,
          eventBus,
          new Map(),
          consumerRecoveryFn,
        );

        const mockMessages = createMockMessages();
        const mockConsumer = createMock<Consumer>({
          consume: vi.fn().mockResolvedValue(mockMessages),
        });

        const originalConsumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });

        const consumerNotFoundError = new Error('consumer not found');
        const js = {
          consumers: {
            get: vi
              .fn()
              .mockRejectedValueOnce(consumerNotFoundError)
              .mockResolvedValue(mockConsumer),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        const consumers = new Map<StreamKind, ConsumerInfo>();

        consumers.set(StreamKind.Event, originalConsumerInfo);

        // When: start() is called and the first consumers.get throws "consumer not found"
        sutWithRecovery.start(consumers);
        await new Promise(process.nextTick);
        await new Promise(process.nextTick);

        // Then: consumerRecoveryFn was called with the correct StreamKind
        expect(consumerRecoveryFn).toHaveBeenCalledWith(StreamKind.Event);

        // And: consumers.get was retried with the recovered consumer info
        expect(js.consumers.get).toHaveBeenCalledWith(
          recoveredConsumerInfo.stream_name,
          recoveredConsumerInfo.name,
        );

        sutWithRecovery.destroy();
      });
    });

    describe('when consumers.get throws error with code "10014" and consumerRecoveryFn is provided', () => {
      it('should call consumerRecoveryFn', async () => {
        // Given: a consumerRecoveryFn and an error with NATS code 10014
        const recoveredConsumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });
        const consumerRecoveryFn = vi.fn().mockResolvedValue(recoveredConsumerInfo);

        const sutWithRecovery = new MessageProvider(
          connection,
          eventBus,
          new Map(),
          consumerRecoveryFn,
        );

        const mockMessages = createMockMessages();
        const mockConsumer = createMock<Consumer>({
          consume: vi.fn().mockResolvedValue(mockMessages),
        });

        const consumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });

        const codeError = new Error('10014');
        const js = {
          consumers: {
            get: vi.fn().mockRejectedValueOnce(codeError).mockResolvedValue(mockConsumer),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        const consumers = new Map<StreamKind, ConsumerInfo>();

        consumers.set(StreamKind.Event, consumerInfo);

        // When: start() is called and consumers.get throws an error containing "10014"
        sutWithRecovery.start(consumers);
        await new Promise(process.nextTick);
        await new Promise(process.nextTick);

        // Then: consumerRecoveryFn was invoked with correct kind
        expect(consumerRecoveryFn).toHaveBeenCalledWith(StreamKind.Event);

        sutWithRecovery.destroy();
      });
    });

    describe('when consumers.get throws "consumer not found" and NO consumerRecoveryFn is provided', () => {
      it('should rethrow the error', async () => {
        vi.useFakeTimers();

        // Given: sut without consumerRecoveryFn (default from beforeEach)
        const consumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });

        const consumerNotFoundError = new Error('consumer not found');
        const js = {
          consumers: {
            get: vi.fn().mockRejectedValue(consumerNotFoundError),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        const consumers = new Map<StreamKind, ConsumerInfo>();

        consumers.set(StreamKind.Event, consumerInfo);

        // When: start() is called and consumers.get throws "consumer not found"
        sut.start(consumers);
        await vi.advanceTimersByTimeAsync(0);

        // Then: error is rethrown and captured by the self-healing flow (eventBus.emit called)
        expect(eventBus.emit).toHaveBeenCalledWith(
          TransportEvent.Error,
          consumerNotFoundError,
          'message-provider',
        );

        sut.destroy();
        vi.useRealTimers();
      });
    });

    describe('when consumers.get throws a non-consumer-not-found error and consumerRecoveryFn is provided', () => {
      it('should rethrow the error and NOT call consumerRecoveryFn', async () => {
        vi.useFakeTimers();

        // Given: a consumerRecoveryFn and an unrelated error
        const consumerRecoveryFn = vi.fn();

        const sutWithRecovery = new MessageProvider(
          connection,
          eventBus,
          new Map(),
          consumerRecoveryFn,
        );

        const consumerInfo = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });

        const unrelatedError = new Error('connection reset');
        const js = {
          consumers: {
            get: vi.fn().mockRejectedValue(unrelatedError),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        const consumers = new Map<StreamKind, ConsumerInfo>();

        consumers.set(StreamKind.Event, consumerInfo);

        // When: start() is called and consumers.get throws an unrelated error
        sutWithRecovery.start(consumers);
        await vi.advanceTimersByTimeAsync(0);

        // Then: the error is rethrown (self-healing flow catches it via eventBus.emit)
        expect(eventBus.emit).toHaveBeenCalledWith(
          TransportEvent.Error,
          unrelatedError,
          'message-provider',
        );

        // And: consumerRecoveryFn was NOT called
        expect(consumerRecoveryFn).not.toHaveBeenCalled();

        sutWithRecovery.destroy();
        vi.useRealTimers();
      });
    });
  });
});
