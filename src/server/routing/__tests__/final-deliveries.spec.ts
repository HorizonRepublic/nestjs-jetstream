import type { JsMsg } from '@nats-io/jetstream';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FinalDeliveries } from '../final-deliveries';

const RUN_LIMIT_MS = 60_000;

const message = (stream: string, streamSequence: number, deliveryCount: number): JsMsg =>
  createMock<JsMsg>({ info: { stream, streamSequence, deliveryCount } });

describe(FinalDeliveries, () => {
  let sut: FinalDeliveries;
  let isFinal: boolean;
  let stream: string;
  let seq: number;
  let deliveries: number;

  beforeEach(() => {
    vi.useFakeTimers();
    isFinal = true;
    stream = faker.string.alpha(8);
    seq = faker.number.int({ min: 1, max: 1_000_000 });
    deliveries = faker.number.int({ min: 1, max: 10 });
    sut = new FinalDeliveries(() => isFinal);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe('happy path', () => {
    it('should resolve true once the running handler settles', async () => {
      // Given a final delivery whose handler is running
      const { promise, resolve } = Promise.withResolvers<void>();

      sut.track(message(stream, seq, deliveries), promise, RUN_LIMIT_MS);

      // When waiting for it and the handler finishes
      const waited = sut.waitFor(stream, seq, deliveries);

      resolve();

      // Then the wait reports that it settled
      expect(await waited).toBe(true);
      expect(sut.waitFor(stream, seq, deliveries)).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should return null for a message with no handler running here', () => {
      // When / Then
      expect(sut.waitFor(stream, seq, deliveries)).toBeNull();
    });

    it('should ignore deliveries that are not the last one', () => {
      // Given an earlier delivery
      isFinal = false;

      // When it is tracked
      sut.track(message(stream, seq, deliveries), new Promise(() => undefined), RUN_LIMIT_MS);

      // Then nothing waits on it
      expect(sut.waitFor(stream, seq, deliveries)).toBeNull();
    });

    it('should resolve true when the handler rejects', async () => {
      // Given a handler that fails
      const { promise, reject } = Promise.withResolvers<void>();

      sut.track(message(stream, seq, deliveries), promise, RUN_LIMIT_MS);
      const waited = sut.waitFor(stream, seq, deliveries);

      // When it rejects
      reject(new Error(faker.lorem.word()));

      // Then its own settlement handled the message
      expect(await waited).toBe(true);
    });

    it('should resolve false once the handler outlives its run limit', async () => {
      // Given a handler that never finishes
      sut.track(message(stream, seq, deliveries), new Promise(() => undefined), RUN_LIMIT_MS);
      const waited = sut.waitFor(stream, seq, deliveries);

      // When the run limit passes
      await vi.advanceTimersByTimeAsync(RUN_LIMIT_MS);

      // Then it counts as hung
      expect(await waited).toBe(false);
    });

    it('should resolve false at once when the run limit already passed', async () => {
      // Given a handler tracked long ago
      sut.track(message(stream, seq, deliveries), new Promise(() => undefined), RUN_LIMIT_MS);
      await vi.advanceTimersByTimeAsync(RUN_LIMIT_MS + 1);

      // When / Then
      expect(await sut.waitFor(stream, seq, deliveries)).toBe(false);
    });

    it('should wait without a limit when the run limit is infinite', async () => {
      // Given an unlimited handler
      const { promise, resolve } = Promise.withResolvers<void>();

      sut.track(message(stream, seq, deliveries), promise, Number.POSITIVE_INFINITY);
      const waited = sut.waitFor(stream, seq, deliveries);

      // When a long time passes and then it finishes
      await vi.advanceTimersByTimeAsync(RUN_LIMIT_MS * 10);
      resolve();

      // Then it still settles on its own
      expect(await waited).toBe(true);
    });
    it('should not match another delivery of the same message', () => {
      // Given a final delivery whose handler is running
      sut.track(message(stream, seq, deliveries), new Promise(() => undefined), RUN_LIMIT_MS);

      // When / Then: an advisory about a different delivery count is not about it
      expect(sut.waitFor(stream, seq, deliveries + 1)).toBeNull();
    });

    it('should resolve every pending wait as hung when abandoned', async () => {
      // Given a wait on a handler with no run limit
      sut.track(
        message(stream, seq, deliveries),
        new Promise(() => undefined),
        Number.POSITIVE_INFINITY,
      );
      const waited = sut.waitFor(stream, seq, deliveries);

      // When the process stops waiting
      sut.abandonWaits();

      // Then the capture proceeds rather than being lost
      expect(await waited).toBe(false);
    });
  });
});
