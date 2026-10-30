import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Codec } from '../../interfaces';
import { RpcReplyInbox } from '../rpc-reply-inbox';

describe(RpcReplyInbox, () => {
  let sut: RpcReplyInbox;
  let codec: Codec;

  beforeEach(() => {
    vi.useFakeTimers();
    codec = createMock<Codec>();
    sut = new RpcReplyInbox(codec, faker.lorem.word());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe('armTimeout()', () => {
    it('should expire a pending request exactly once', () => {
      // Given
      const id = faker.string.uuid();
      const onExpired = vi.fn();

      sut.register(id, vi.fn());
      sut.armTimeout(id, 1_000, onExpired);

      // When
      vi.advanceTimersByTime(1_500);

      // Then
      expect(onExpired).toHaveBeenCalledOnce();

      expect(sut.has(id)).toBe(false);
    });

    it('should clear the previous deadline when re-armed for the same id', () => {
      // Given
      const id = faker.string.uuid();
      const first = vi.fn();
      const second = vi.fn();

      sut.register(id, vi.fn());
      sut.armTimeout(id, 1_000, first);
      sut.armTimeout(id, 5_000, second);

      // When: the first deadline passes, only the re-armed one remains
      vi.advanceTimersByTime(2_000);

      expect(first).not.toHaveBeenCalled();

      vi.advanceTimersByTime(4_000);

      // Then
      expect(second).toHaveBeenCalledOnce();
    });

    it('should not fire after the request was discarded', () => {
      // Given
      const id = faker.string.uuid();
      const onExpired = vi.fn();

      sut.register(id, vi.fn());
      sut.armTimeout(id, 1_000, onExpired);

      // When
      sut.discard(id);
      vi.advanceTimersByTime(2_000);

      // Then
      expect(onExpired).not.toHaveBeenCalled();
    });
  });

  describe('discard()', () => {
    it('should report whether the request was still pending', () => {
      // Given
      const id = faker.string.uuid();

      sut.register(id, vi.fn());

      // When / Then
      expect(sut.discard(id)).toBe(true);

      expect(sut.discard(id)).toBe(false);
    });
  });

  describe('cancel()', () => {
    it('should drop a pending request and run its cancel callback once', () => {
      // Given
      const id = faker.string.uuid();
      const callback = vi.fn();
      const onCancel = vi.fn();
      const onExpired = vi.fn();

      sut.register(id, callback, onCancel);
      sut.armTimeout(id, 1_000, onExpired);

      // When
      sut.cancel(id);
      sut.cancel(id);
      vi.advanceTimersByTime(1_500);

      // Then
      expect(onCancel).toHaveBeenCalledOnce();
      expect(callback).not.toHaveBeenCalled();
      expect(onExpired).not.toHaveBeenCalled();
      expect(sut.has(id)).toBe(false);
    });

    it('should not run the cancel callback of a request that already settled', () => {
      // Given a request whose deadline already fired
      const id = faker.string.uuid();
      const onCancel = vi.fn();

      sut.register(id, vi.fn(), onCancel);
      sut.armTimeout(id, 1_000, vi.fn());
      vi.advanceTimersByTime(1_500);

      // When
      sut.cancel(id);

      // Then
      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  describe('rejectAll()', () => {
    it('should fail every pending request and clear deadlines', () => {
      // Given
      const callbackA = vi.fn();
      const callbackB = vi.fn();
      const boom = new Error('Connection lost');

      sut.register('a', callbackA);
      sut.register('b', callbackB);
      sut.armTimeout('a', 1_000, vi.fn());

      // When
      sut.rejectAll(boom);

      // Then
      expect(callbackA).toHaveBeenCalledWith({ err: boom, response: null, isDisposed: true });

      expect(callbackB).toHaveBeenCalledWith({ err: boom, response: null, isDisposed: true });

      expect(sut.has('a')).toBe(false);

      expect(sut.address).toBeNull();
    });

    it('should not cancel a request whose rejection makes its caller unsubscribe', () => {
      // Given a callback that cancels its own request, as an rxjs teardown does
      const id = faker.string.uuid();
      const onCancel = vi.fn();

      sut.register(
        id,
        () => {
          sut.cancel(id);
        },
        onCancel,
      );

      // When
      sut.rejectAll(new Error('Connection lost'));

      // Then
      expect(onCancel).not.toHaveBeenCalled();
    });
  });
});
