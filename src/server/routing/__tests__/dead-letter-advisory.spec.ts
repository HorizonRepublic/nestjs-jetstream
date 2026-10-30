import { Logger } from '@nestjs/common';

import { RetentionPolicy } from '@nats-io/jetstream';
import type { JetStreamManager, StoredMsg, StreamInfo } from '@nats-io/jetstream';
import { headers as natsHeaders } from '@nats-io/transport-node';
import type { Msg, MsgCallback, NatsConnection, Subscription } from '@nats-io/transport-node';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { JsonCodec } from '../../../codec';
import type { ConnectionProvider } from '../../../connection';
import { DeliveryErrorReason } from '../../../errors';
import { DeadLetterAdvisoryListener } from '../dead-letter-advisory';
import type { DeadLetterCapture } from '../dead-letter-capture';
import type { FinalDeliveries } from '../final-deliveries';
import type { DeadLetterSource, DeadLetterWatchTarget } from '../routing.types';

const codec = new JsonCodec();

describe(DeadLetterAdvisoryListener, () => {
  let sut: DeadLetterAdvisoryListener;
  let callbacks: Map<string, MsgCallback<Msg>>;
  let subscribe: Mock;
  let getMessage: Mock;
  let deleteMessage: Mock;
  let streamInfo: Mock;
  let captureSource: Mock;
  let target: DeadLetterWatchTarget;
  let connection: ConnectionProvider;

  const advisory = (body: unknown): Msg =>
    createMock<Msg>({
      json: <T>(): T => {
        if (typeof body === 'string') throw new SyntaxError('Unexpected token');

        return body as T;
      },
    });

  const stored = (seq: number, payload: unknown): StoredMsg =>
    createMock<StoredMsg>({
      subject: faker.lorem.word(),
      seq,
      data: codec.encode(payload),
      header: natsHeaders(),
      time: faker.date.recent(),
    });

  /** Deliver an advisory to the subscription for `target` and let the handler settle. */
  const receive = async (body: unknown): Promise<void> => {
    const callback = callbacks.get(
      `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${target.stream}.${target.consumer}`,
    );

    void callback?.(null, advisory(body));
    await vi.waitFor(() => {
      expect(getMessage.mock.calls.length + warn.mock.calls.length).toBeGreaterThan(0);
    });
    await new Promise(process.nextTick);
  };

  let warn: Mock;
  let error: Mock;

  beforeEach(() => {
    callbacks = new Map();
    subscribe = vi.fn((subject: string, opts: { callback: MsgCallback<Msg> }) => {
      callbacks.set(subject, opts.callback);

      return createMock<Subscription>();
    });
    getMessage = vi.fn();
    deleteMessage = vi.fn().mockResolvedValue(true);
    streamInfo = vi
      .fn()
      .mockResolvedValue(
        createMock<StreamInfo>({ config: { retention: RetentionPolicy.Workqueue } }),
      );
    captureSource = vi.fn().mockImplementation(async (source: DeadLetterSource) => {
      await source.release('Moved to DLQ stream');
    });
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined) as Mock;
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined) as Mock;

    connection = createMock<ConnectionProvider>({
      getConnection: vi.fn().mockResolvedValue(createMock<NatsConnection>({ subscribe })),
      getJetStreamManager: vi.fn().mockResolvedValue(
        createMock<JetStreamManager>({
          streams: { getMessage, deleteMessage, info: streamInfo },
        }),
      ),
    });

    target = { stream: faker.string.alpha(12), consumer: faker.string.alpha(12) };
    sut = new DeadLetterAdvisoryListener(
      connection,
      createMock<DeadLetterCapture>({ captureSource }),
      codec,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  describe('happy path', () => {
    it('should subscribe to the consumer advisory in a queue group shared by every replica', async () => {
      // When
      await sut.watch([target]);

      // Then
      expect(subscribe).toHaveBeenCalledWith(
        `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${target.stream}.${target.consumer}`,
        expect.objectContaining({ queue: target.consumer }),
      );
    });

    it('should capture the stored message with the delivery count from the advisory', async () => {
      // Given
      const seq = faker.number.int({ min: 1, max: 10_000 });
      const payload = { id: faker.string.uuid() };
      const message = stored(seq, payload);

      getMessage.mockResolvedValue(message);
      await sut.watch([target]);

      // When
      await receive({
        stream: target.stream,
        consumer: target.consumer,
        stream_seq: seq,
        deliveries: 3,
      });

      // Then
      expect(getMessage).toHaveBeenCalledWith(target.stream, { seq });
      expect(captureSource).toHaveBeenCalledTimes(1);

      const [source, data, reason] = captureSource.mock.calls[0]!;

      expect(source).toMatchObject({
        subject: message.subject,
        stream: target.stream,
        streamSequence: seq,
        deliveryCount: 3,
        timestamp: message.time,
      });
      expect(data).toEqual(payload);
      expect(reason).toEqual(
        expect.objectContaining({
          name: 'JetstreamDeliveryError',
          reason: DeliveryErrorReason.DeliveriesExhausted,
        }),
      );
    });

    it('should delete the message from a work-queue stream once captured', async () => {
      // Given
      const seq = faker.number.int({ min: 1, max: 10_000 });

      getMessage.mockResolvedValue(stored(seq, {}));
      await sut.watch([target]);

      // When
      await receive({ stream: target.stream, stream_seq: seq, deliveries: 2 });

      // Then
      expect(deleteMessage).toHaveBeenCalledWith(target.stream, seq, false);
    });

    it('should finish a capture that was running when it stopped before reporting idle', async () => {
      // Given a capture still waiting on the dead-letter callback
      const seq = faker.number.int({ min: 1, max: 10_000 });
      const { promise: captured, resolve: finishCapture } = Promise.withResolvers<void>();

      getMessage.mockResolvedValue(stored(seq, {}));
      captureSource.mockImplementation(async (source: DeadLetterSource) => {
        await captured;
        await source.release('Moved to DLQ stream');
      });
      await sut.watch([target]);
      await receive({ stream: target.stream, stream_seq: seq, deliveries: 2 });

      // When the listener stops and the capture completes afterwards
      sut.stop();

      let idle = false;
      const waiting = sut.whenIdle().then(() => {
        idle = true;
      });

      await new Promise(process.nextTick);
      expect(idle).toBe(false);
      finishCapture();
      await waiting;

      // Then the captured message was deleted before the listener reported idle
      expect(deleteMessage).toHaveBeenCalledWith(target.stream, seq, false);
    });
  });

  describe('edge cases', () => {
    it.each([RetentionPolicy.Limits, RetentionPolicy.Interest])(
      'should keep the message in a %s stream, which other consumers may still read',
      async (retention) => {
        // Given
        streamInfo.mockResolvedValue(createMock<StreamInfo>({ config: { retention } }));
        getMessage.mockResolvedValue(stored(5, {}));
        await sut.watch([target]);

        // When
        await receive({ stream: target.stream, stream_seq: 5, deliveries: 2 });

        // Then
        expect(captureSource).toHaveBeenCalledTimes(1);
        expect(deleteMessage).not.toHaveBeenCalled();
      },
    );

    it('should keep the message when the stream retention cannot be read', async () => {
      // Given
      streamInfo.mockRejectedValue(new Error('timeout'));
      getMessage.mockResolvedValue(stored(5, {}));
      await sut.watch([target]);

      // When
      await receive({ stream: target.stream, stream_seq: 5, deliveries: 2 });

      // Then
      expect(captureSource).toHaveBeenCalledTimes(1);
      expect(deleteMessage).not.toHaveBeenCalled();
    });

    it('should report zero deliveries when the advisory omits the count', async () => {
      // Given
      getMessage.mockResolvedValue(stored(3, {}));
      await sut.watch([target]);

      // When
      await receive({ stream: target.stream, stream_seq: 3 });

      // Then
      expect(captureSource.mock.calls[0]![0]).toMatchObject({ deliveryCount: 0 });
    });

    it('should do nothing when the message is already gone', async () => {
      // Given
      getMessage.mockResolvedValue(null);
      await sut.watch([target]);

      // When
      await receive({ stream: target.stream, stream_seq: 9, deliveries: 2 });

      // Then
      expect(captureSource).not.toHaveBeenCalled();
    });

    it('should hand over the raw bytes when the payload cannot be decoded', async () => {
      // Given
      const message = createMock<StoredMsg>({
        subject: faker.lorem.word(),
        seq: 4,
        data: new TextEncoder().encode('{not json'),
        header: natsHeaders(),
        time: new Date(),
      });

      getMessage.mockResolvedValue(message);
      await sut.watch([target]);

      // When
      await receive({ stream: target.stream, stream_seq: 4, deliveries: 2 });

      // Then
      expect(captureSource.mock.calls[0]![1]).toBe(message.data);
    });

    it('should leave the message in place when the capture does not release it', async () => {
      // Given: a capture that keeps the message (DLQ and callback both failed)
      captureSource.mockImplementation(async (source: DeadLetterSource) => {
        source.retain();
      });
      getMessage.mockResolvedValue(stored(6, {}));
      await sut.watch([target]);

      // When
      await receive({ stream: target.stream, stream_seq: 6, deliveries: 2 });

      // Then
      expect(deleteMessage).not.toHaveBeenCalled();
    });

    it('should handle at most eight advisories at once and queue the rest', async () => {
      // Given: fetching hangs until released
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      getMessage.mockImplementation(async () => {
        await gate;

        return null;
      });
      await sut.watch([target]);
      const callback = callbacks.get(
        `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${target.stream}.${target.consumer}`,
      );

      // When: a burst of ten arrives
      for (let seq = 1; seq <= 10; seq += 1) {
        void callback?.(null, advisory({ stream: target.stream, stream_seq: seq, deliveries: 2 }));
      }

      // Then: eight run, two wait, and the queue drains once they finish
      await vi.waitFor(() => {
        expect(getMessage).toHaveBeenCalledTimes(8);
      });
      release();
      await vi.waitFor(() => {
        expect(getMessage).toHaveBeenCalledTimes(10);
      });
    });

    it('should stop listening on stop()', async () => {
      // Given
      const unsubscribe = vi.fn();

      subscribe.mockReturnValue(createMock<Subscription>({ unsubscribe }));
      await sut.watch([target, { stream: target.stream, consumer: faker.string.alpha(10) }]);

      // When
      sut.stop();

      // Then
      expect(unsubscribe).toHaveBeenCalledTimes(2);
    });
  });

  describe('edge cases with the handler still running here', () => {
    const watchWithLocalHandler = async (settled: boolean): Promise<void> => {
      sut = new DeadLetterAdvisoryListener(
        connection,
        createMock<DeadLetterCapture>({ captureSource }),
        codec,
        createMock<FinalDeliveries>({ waitFor: vi.fn().mockResolvedValue(settled) }),
      );
      await sut.watch([target]);
    };

    const deliver = (seq: number): void => {
      const callback = callbacks.get(
        `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${target.stream}.${target.consumer}`,
      );

      void callback?.(null, advisory({ stream_seq: seq, deliveries: 1 }));
    };

    it('should leave the message to a handler that settles it', async () => {
      // Given a handler of that delivery that settles while the advisory waits
      const seq = faker.number.int({ min: 1, max: 10_000 });

      await watchWithLocalHandler(true);

      // When the advisory arrives
      deliver(seq);
      await sut.whenIdle();

      // Then nothing is read back or captured
      expect(getMessage).not.toHaveBeenCalled();
      expect(captureSource).not.toHaveBeenCalled();
    });

    it('should capture the message once the handler counts as hung', async () => {
      // Given a handler of that delivery that outlives its run limit
      const seq = faker.number.int({ min: 1, max: 10_000 });

      getMessage.mockResolvedValue(stored(seq, { id: faker.string.uuid() }));
      await watchWithLocalHandler(false);

      // When the advisory arrives
      deliver(seq);
      await sut.whenIdle();

      // Then it is captured as usual
      expect(captureSource).toHaveBeenCalledOnce();
    });
  });

  describe('edge cases on restart', () => {
    it('should replace the subscriptions when watching again', async () => {
      // Given a listener already watching the target
      const unsubscribe = vi.fn();

      subscribe.mockReturnValue(createMock<Subscription>({ unsubscribe }));
      await sut.watch([target]);

      // When it is asked to watch again
      await sut.watch([target]);

      // Then the first subscription is gone, so each advisory is captured once
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(unsubscribe).toHaveBeenCalledOnce();
    });
  });

  describe('error paths', () => {
    it('should log a subscription error and not touch the stream', async () => {
      // Given
      await sut.watch([target]);
      const callback = callbacks.get(
        `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${target.stream}.${target.consumer}`,
      );

      // When: the server rejects the subscription, e.g. for missing permissions
      void callback?.(new Error('Permissions Violation'), advisory({}));

      // Then
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(target.consumer),
        expect.any(Error),
      );
      expect(getMessage).not.toHaveBeenCalled();
    });

    it('should warn and skip an advisory it cannot parse', async () => {
      // Given
      await sut.watch([target]);

      // When
      await receive('garbage');

      // Then
      expect(getMessage).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it('should warn and skip an advisory without a stream sequence', async () => {
      // Given
      await sut.watch([target]);

      // When
      await receive({ stream: target.stream, deliveries: 2 });

      // Then
      expect(getMessage).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it('should log and survive when the message cannot be fetched', async () => {
      // Given
      getMessage.mockRejectedValue(new Error('timeout'));
      await sut.watch([target]);

      // When
      await receive({ stream: target.stream, stream_seq: 3, deliveries: 2 });
      await vi.waitFor(() => {
        expect(error).toHaveBeenCalled();
      });

      // Then
      expect(captureSource).not.toHaveBeenCalled();
    });

    it('should log when the captured message cannot be deleted', async () => {
      // Given
      deleteMessage.mockRejectedValue(new Error('no responders'));
      getMessage.mockResolvedValue(stored(8, {}));
      await sut.watch([target]);

      // When
      await receive({ stream: target.stream, stream_seq: 8, deliveries: 2 });

      // Then
      await vi.waitFor(() => {
        expect(error).toHaveBeenCalledWith(expect.stringContaining('8'), expect.any(Error));
      });
    });
  });
});
