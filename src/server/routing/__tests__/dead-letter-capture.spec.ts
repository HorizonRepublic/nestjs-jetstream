import { Logger } from '@nestjs/common';

import type { DeliveryInfo, JetStreamManager, JsMsg, StoredMsg } from '@nats-io/jetstream';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { ConnectionProvider } from '../../../connection';
import { EventBus } from '../../../hooks';
import type { DeadLetterConfig, JetstreamModuleOptions } from '../../../interfaces';
import { resolveOtelOptions } from '../../../otel';
import { DeadLetterCapture } from '../dead-letter-capture';
import { PatternRegistry } from '../pattern-registry';
import type { DeadLetterSource } from '../routing.types';

describe(DeadLetterCapture, () => {
  let sut: DeadLetterCapture;
  let publish: Mock;
  let getMessage: Mock;
  let onDeadLetter: Mock;
  let stream: string;

  const options: JetstreamModuleOptions = {
    name: 'svc',
    servers: ['nats://localhost:4222'],
    dlq: {},
  };

  const liveMsg = (seq: number): JsMsg =>
    createMock<JsMsg>({
      subject: faker.lorem.word(),
      data: new TextEncoder().encode('{}'),
      headers: undefined,
      term: vi.fn(),
      nak: vi.fn(),
      info: {
        stream,
        streamSequence: seq,
        deliveryCount: 3,
        timestampNanos: 1_700_000_000_123 * 1_000_000 + 456_789,
      } as DeliveryInfo,
    });

  const source = (seq: number): DeadLetterSource & { release: Mock; retain: Mock } => ({
    subject: faker.lorem.word(),
    data: new TextEncoder().encode('{}'),
    headers: undefined,
    stream,
    streamSequence: seq,
    deliveryCount: 3,
    timestamp: new Date(1_700_000_000_123),
    release: vi.fn().mockResolvedValue(undefined),
    retain: vi.fn(),
  });

  beforeEach(() => {
    stream = faker.string.alpha(10);
    publish = vi.fn().mockResolvedValue(undefined);
    getMessage = vi.fn().mockResolvedValue(createMock<StoredMsg>());
    onDeadLetter = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const config: DeadLetterConfig = { maxDeliverByStream: new Map([[stream, 3]]), onDeadLetter };
    const connection = createMock<ConnectionProvider>({
      getJetStreamClient: vi.fn().mockReturnValue({ publish }),
      getJetStreamManager: vi
        .fn()
        .mockResolvedValue(createMock<JetStreamManager>({ streams: { getMessage } })),
    });

    sut = new DeadLetterCapture(
      createMock<PatternRegistry>(),
      createMock<EventBus>(),
      config,
      resolveOtelOptions({ enabled: false }),
      'svc',
      null,
      connection,
      options,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  describe('happy path', () => {
    it('should key the DLQ publish on stream, sequence and stored time', async () => {
      // When
      await sut.captureSource(source(42), {}, new Error('boom'));

      // Then
      expect(publish.mock.calls[0]![2].msgID).toBe(`${stream}:42:1700000000123`);
    });

    it('should give a live delivery the same key as the stored message', async () => {
      // When
      await sut.capture(liveMsg(42), {}, new Error('boom'));

      // Then: timestampNanos truncated to milliseconds, as StoredMsg.time is
      expect(publish.mock.calls[0]![2].msgID).toBe(`${stream}:42:1700000000123`);
    });
  });

  describe('edge cases', () => {
    it('should capture a message only once while it is remembered', async () => {
      // Given
      const first = source(7);
      const second = source(7);

      // When
      await sut.captureSource(first, {}, new Error('boom'));
      await sut.captureSource(second, {}, new Error('boom'));

      // Then: the duplicate is taken out of circulation without a second callback
      expect(onDeadLetter).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(second.release).toHaveBeenCalled();
    });

    it('should capture again after a capture that kept the message', async () => {
      // Given: the first attempt fails all the way to retain()
      publish.mockRejectedValue(new Error('down'));
      onDeadLetter.mockRejectedValueOnce(new Error('callback down'));
      const first = source(9);

      await sut.captureSource(first, {}, new Error('boom'));
      expect(first.retain).toHaveBeenCalled();

      // When: it is reported again
      await sut.captureSource(source(9), {}, new Error('boom'));

      // Then: the second attempt runs
      expect(onDeadLetter).toHaveBeenCalledTimes(2);
    });

    it('should not capture a live delivery whose message is already gone from the stream', async () => {
      // Given: another replica captured and deleted it
      getMessage.mockResolvedValue(null);
      const msg = liveMsg(11);

      // When
      await sut.capture(msg, {}, new Error('boom'));

      // Then
      expect(getMessage).toHaveBeenCalledWith(stream, { seq: 11 });
      expect(onDeadLetter).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(msg.term).toHaveBeenCalled();
    });
  });

  describe('error paths', () => {
    it('should still capture when the stream cannot be checked', async () => {
      // Given
      getMessage.mockRejectedValue(new Error('timeout'));

      // When
      await sut.capture(liveMsg(12), {}, new Error('boom'));

      // Then: losing a dead letter is worse than a duplicate
      expect(onDeadLetter).toHaveBeenCalledTimes(1);
    });
  });
});
