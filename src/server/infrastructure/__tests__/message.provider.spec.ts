import type { Consumer, ConsumerInfo, ConsumerMessages, JsMsg } from '@nats-io/jetstream';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { ConnectionProvider } from '../../../connection';
import { EventBus } from '../../../hooks';
import { StreamKind, TransportEvent } from '../../../interfaces';
import { MessageProvider } from '../message.provider';

/** Status-event iterator next(): yields the given events, then blocks until stopped. */
const createStatusIterator = (
  events: { type: string; count: number }[],
  isStopped: () => boolean,
  onBlock: (unblock: () => void) => void,
): (() => Promise<IteratorResult<{ type: string; count: number }>>) => {
  let i = 0;

  return async (): Promise<IteratorResult<{ type: string; count: number }>> => {
    if (i < events.length) {
      return { done: false, value: events[i++]! };
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

/** Mock ConsumerMessages supporting both callback and async-iterator consumption modes. */
interface MockMessages extends ConsumerMessages {
  /** Push pending messages through the registered callback. */
  deliver(): void;
  /** Register the callback passed via `consume({ callback })`. */
  setCallback(cb: (msg: JsMsg) => void): void;
}

const createMockMessages = (
  msgs: JsMsg[] = [],
  statusEvents: { type: string; count: number }[] = [],
): MockMessages => {
  let stopped = false;
  let resolveWait: (() => void) | null = null;
  let resolveClosed: (() => void) | null = null;
  let callback: ((msg: JsMsg) => void) | null = null;

  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const deliverPending = (): void => {
    if (!callback) return;
    for (const msg of msgs.splice(0, msgs.length)) callback(msg);
  };

  const mockMessages: MockMessages = {
    stop: vi.fn(() => {
      stopped = true;
      resolveWait?.();
      resolveClosed?.();
    }),
    close: vi.fn(() => {
      stopped = true;
      resolveWait?.();
      resolveClosed?.();

      return closedPromise;
    }),
    closed: vi.fn(() => closedPromise),
    getProcessed: vi.fn(() => 0),
    getPending: vi.fn(() => msgs.length),
    getReceived: vi.fn(() => 0),
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
    // method shorthand required by method-signature-style on the MockMessages interface
    // oxlint-disable-next-line prefer-arrow/prefer-arrow-functions
    setCallback(cb: (msg: JsMsg) => void): void {
      callback = cb;
      // Auto-deliver anything queued before the callback was registered.
      deliverPending();
    },
    // same as above
    // oxlint-disable-next-line prefer-arrow/prefer-arrow-functions
    deliver(): void {
      deliverPending();
    },
    [Symbol.asyncIterator]: (): AsyncIterator<JsMsg> => {
      let index = 0;

      return {
        next: async (): Promise<IteratorResult<JsMsg>> => {
          if (stopped || index >= msgs.length) {
            return { done: true, value: undefined };
          }

          return { done: false, value: msgs[index++]! };
        },
      };
    },
  };

  return mockMessages as unknown as MockMessages;
};

interface ConsumeOptsWithCallback {
  callback?(msg: JsMsg): void;
}

/** Consumer mock whose `consume()` wires the caller's callback into the mock messages. */
const makeConsumer = (messages: MockMessages): Consumer => {
  const consume = vi.fn(async (opts?: ConsumeOptsWithCallback) => {
    if (opts?.callback) messages.setCallback(opts.callback);

    return messages;
  });

  return createMock<Consumer>({ consume });
};

describe(MessageProvider, () => {
  let sut: MessageProvider;

  let connection: Mocked<ConnectionProvider>;
  let eventBus: Mocked<EventBus>;
  let reconnects: Subject<void>;

  beforeEach(() => {
    reconnects = new Subject<void>();
    connection = createMock<ConnectionProvider>({ reconnects$: reconnects.asObservable() });
    eventBus = createMock<EventBus>();

    sut = new MessageProvider(connection, eventBus);
  });

  afterEach(vi.resetAllMocks);

  describe('destroy()', () => {
    describe('when called after start', () => {
      it('should reinitialize subjects so start() can be called again', async () => {
        // Given: a consumer that completes immediately
        const mockConsumer = makeConsumer(createMockMessages());

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

    describe('when schedule ticks are observed', () => {
      it('should complete the schedule stream and hand out a fresh one', () => {
        // Given
        let completed = false;

        sut.schedules$.subscribe({ complete: () => (completed = true) });

        // When
        sut.destroy();

        // Then
        expect(completed).toBe(true);

        let completedAfter = false;

        sut.schedules$.subscribe({ complete: () => (completedAfter = true) });
        expect(completedAfter).toBe(false);
      });
    });

    describe('when orderedReadyReject is pending', () => {
      it('should reject with "Destroyed before ordered consumer connected"', async () => {
        // Given: startOrdered() called but consumer not yet connected
        const js = {
          consumers: {
            get: vi.fn().mockReturnValue(
              new Promise(() => {
                // Never resolves, simulates a hanging connection
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
        const mockConsumer = makeConsumer(mockMessages);

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

    describe('when the connection reconnects during a long backoff', () => {
      it('should retry at once instead of waiting out the delay', async () => {
        vi.useFakeTimers();

        // Given: a flow that failed long enough to back off for 30 seconds
        const js = {
          consumers: { get: vi.fn().mockRejectedValue(new Error('no responders')) },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);
        sut.start(
          new Map([
            [
              StreamKind.Event,
              createMock<ConsumerInfo>({
                name: faker.lorem.word(),
                stream_name: faker.lorem.word(),
              }),
            ],
          ]),
        );

        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(31_000);
        }

        const attempts = js.consumers.get.mock.calls.length;

        js.consumers.get.mockResolvedValue(makeConsumer(createMockMessages()));

        // When: NATS comes back
        reconnects.next();
        await vi.advanceTimersByTimeAsync(0);

        // Then: the flow is live again without waiting for the timer
        expect(js.consumers.get.mock.calls.length).toBe(attempts + 1);
        expect(sut.getFlowStates()[0]?.active).toBe(true);

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

  describe('getFlowStates()', () => {
    const eventConsumers = (name: string): Map<StreamKind, ConsumerInfo> =>
      new Map([
        [StreamKind.Event, createMock<ConsumerInfo>({ name, stream_name: faker.lorem.word() })],
      ]);

    afterEach(() => {
      sut.destroy();
      vi.useRealTimers();
    });

    describe('happy path', () => {
      it('should report a live flow', async () => {
        // Given: a consumer that connects at once
        const name = faker.lorem.word();
        const js = {
          consumers: { get: vi.fn().mockResolvedValue(makeConsumer(createMockMessages())) },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        // When
        sut.start(eventConsumers(name));
        await new Promise(process.nextTick);

        // Then
        expect(sut.getFlowStates()).toEqual([
          {
            kind: StreamKind.Event,
            consumer: name,
            active: true,
            connectedOnce: true,
            failures: 0,
            downSince: null,
            lastError: null,
          },
        ]);
      });

      it('should clear the failure streak once the flow recovers', async () => {
        // Given: one failed attempt, then a live consumer
        vi.useFakeTimers();
        const js = {
          consumers: {
            get: vi
              .fn()
              .mockRejectedValueOnce(new Error(faker.lorem.sentence()))
              .mockResolvedValue(makeConsumer(createMockMessages())),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);
        sut.start(eventConsumers(faker.lorem.word()));
        await vi.advanceTimersByTimeAsync(0);

        // When: the retry after the backoff succeeds
        await vi.advanceTimersByTimeAsync(300);

        // Then
        expect(sut.getFlowStates()[0]).toEqual(
          expect.objectContaining({ active: true, failures: 0, downSince: null, lastError: null }),
        );
      });
    });

    describe('edge cases', () => {
      it('should mark a flow down from the moment its live iterator ends', async () => {
        // Given: a live consumer
        vi.useFakeTimers();
        const messages = createMockMessages();
        const js = { consumers: { get: vi.fn().mockResolvedValue(makeConsumer(messages)) } };

        connection.getJetStreamClient.mockReturnValue(js as never);
        sut.start(eventConsumers(faker.lorem.word()));
        await vi.advanceTimersByTimeAsync(0);
        js.consumers.get.mockReturnValue(new Promise(() => {}));

        // When: the iterator closes and the restart has not connected yet
        const closedAt = Date.now();

        messages.stop();
        await vi.advanceTimersByTimeAsync(0);

        // Then
        expect(sut.getFlowStates()[0]).toEqual(
          expect.objectContaining({ active: false, connectedOnce: true, downSince: closedAt }),
        );
      });

      it('should forget every flow on destroy()', async () => {
        // Given
        const js = {
          consumers: { get: vi.fn().mockResolvedValue(makeConsumer(createMockMessages())) },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);
        sut.start(eventConsumers(faker.lorem.word()));
        await new Promise(process.nextTick);

        // When
        sut.destroy();

        // Then
        expect(sut.getFlowStates()).toEqual([]);
      });
    });

    describe('error paths', () => {
      it('should count failures since start for a flow that never connected', async () => {
        // Given: an externally managed consumer that stays absent
        vi.useFakeTimers();
        const startedAt = Date.now();
        const reason = faker.lorem.sentence();
        const js = { consumers: { get: vi.fn().mockRejectedValue(new Error(reason)) } };

        connection.getJetStreamClient.mockReturnValue(js as never);

        // When: three attempts fail
        sut.start(eventConsumers(faker.lorem.word()));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(200);
        await vi.advanceTimersByTimeAsync(400);

        // Then: still down since the start
        expect(sut.getFlowStates()[0]).toEqual(
          expect.objectContaining({
            active: false,
            connectedOnce: false,
            failures: 3,
            downSince: startedAt,
            lastError: reason,
          }),
        );
      });

      it('should track the ordered flow without a durable name', async () => {
        // Given: an ordered consumer that fails at once
        const js = { consumers: { get: vi.fn().mockRejectedValue(new Error('boom')) } };

        connection.getJetStreamClient.mockReturnValue(js as never);

        // When
        await expect(sut.startOrdered(faker.lorem.word(), ['a.>'])).rejects.toThrow('boom');

        // Then
        expect(sut.getFlowStates()).toEqual([
          expect.objectContaining({ kind: StreamKind.Ordered, consumer: null, failures: 1 }),
        ]);
      });
    });
  });

  describe('monitorConsumerHealth', () => {
    describe('when 2+ heartbeats are missed', () => {
      it('should stop the consumer messages iterator', async () => {
        // Given: consumer with status that emits HeartbeatsMissed with data >= 2
        const statusEvents = [{ type: 'heartbeats_missed', count: 2 }];

        const mockMessages = createMockMessages([], statusEvents);

        const mockConsumer = makeConsumer(mockMessages);

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

        const mockConsumer = makeConsumer(mockMessages);

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

        // Then: messages.stop() NOT called, 1 missed heartbeat is within threshold
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
        const mockConsumer = makeConsumer(mockMessages);

        const js = {
          consumers: {
            get: vi
              .fn()
              .mockRejectedValueOnce(new Error('stream not found'))
              .mockResolvedValue(mockConsumer),
          },
        };

        connection.getJetStreamClient.mockReturnValue(js as never);

        // When: startOrdered() called; attach .catch immediately to avoid unhandled rejection
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

        const mockConsumer = makeConsumer(mockMessages);

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

        const mockConsumer = makeConsumer(mockMessages);

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
        const mockConsumer = makeConsumer(mockMessages);

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
        expect(consumerRecoveryFn).toHaveBeenCalledWith(StreamKind.Event, originalConsumerInfo);

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
        const mockConsumer = makeConsumer(mockMessages);

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
        expect(consumerRecoveryFn).toHaveBeenCalledWith(StreamKind.Event, consumerInfo);

        sutWithRecovery.destroy();
      });
    });

    describe('when a broadcast consumer vanishes after its position was refreshed', () => {
      it('should hand the freshest consumer info to consumerRecoveryFn', async () => {
        vi.useFakeTimers();

        // Given: a broadcast flow whose consumer reports a newer ack floor later on
        const stream = faker.lorem.word();
        const name = faker.lorem.word();
        const initial = createMock<ConsumerInfo>({ name, stream_name: stream });
        const refreshed = createMock<ConsumerInfo>({ name, stream_name: stream });
        const firstMessages = createMockMessages();
        const consumer = createMock<Consumer>({
          consume: vi.fn(async () => firstMessages),
          info: vi.fn().mockResolvedValue(refreshed),
        });
        const consumerRecoveryFn = vi.fn().mockResolvedValue(refreshed);
        const sutWithRecovery = new MessageProvider(
          connection,
          eventBus,
          new Map(),
          consumerRecoveryFn,
        );
        const get = vi
          .fn()
          .mockResolvedValueOnce(consumer)
          .mockRejectedValueOnce(new Error('consumer not found'))
          .mockResolvedValue(makeConsumer(createMockMessages()));

        connection.getJetStreamClient.mockReturnValue({ consumers: { get } } as never);
        sutWithRecovery.start(new Map([[StreamKind.Broadcast, initial]]));
        await vi.advanceTimersByTimeAsync(10_000);

        // When: the consumer goes away
        firstMessages.stop();
        await vi.advanceTimersByTimeAsync(1_000);

        // Then
        expect(consumer.info).toHaveBeenCalled();
        expect(consumerRecoveryFn).toHaveBeenCalledWith(StreamKind.Broadcast, refreshed);

        sutWithRecovery.destroy();
        vi.useRealTimers();
      });

      it('should keep the last known info when a refresh fails', async () => {
        vi.useFakeTimers();

        // Given
        const initial = createMock<ConsumerInfo>({
          name: faker.lorem.word(),
          stream_name: faker.lorem.word(),
        });
        const firstMessages = createMockMessages();
        const consumer = createMock<Consumer>({
          consume: vi.fn(async () => firstMessages),
          info: vi.fn().mockRejectedValue(new Error('timeout')),
        });
        const consumerRecoveryFn = vi.fn().mockResolvedValue(initial);
        const sutWithRecovery = new MessageProvider(
          connection,
          eventBus,
          new Map(),
          consumerRecoveryFn,
        );
        const get = vi
          .fn()
          .mockResolvedValueOnce(consumer)
          .mockRejectedValueOnce(new Error('consumer not found'))
          .mockResolvedValue(makeConsumer(createMockMessages()));

        connection.getJetStreamClient.mockReturnValue({ consumers: { get } } as never);
        sutWithRecovery.start(new Map([[StreamKind.Broadcast, initial]]));
        await vi.advanceTimersByTimeAsync(10_000);

        // When
        firstMessages.stop();
        await vi.advanceTimersByTimeAsync(1_000);

        // Then
        expect(consumerRecoveryFn).toHaveBeenCalledWith(StreamKind.Broadcast, initial);

        sutWithRecovery.destroy();
        vi.useRealTimers();
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
