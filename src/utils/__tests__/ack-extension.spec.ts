import { faker } from '@faker-js/faker';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _ackExtensionPoolForTest,
  DEFAULT_MAX_ACK_EXTENSION_MS,
  resolveAckExtension,
  startAckExtensionTimer,
} from '../ack-extension';
import type { AckExtension } from '../ack-extension.types';

const extension = (intervalMs: number, maxDurationMs = DEFAULT_MAX_ACK_EXTENSION_MS): AckExtension => ({
  intervalMs,
  maxDurationMs,
});

const target = () => ({ subject: faker.lorem.word(), working: vi.fn() });

describe('resolveAckExtension', () => {
  describe('happy path', () => {
    it('should use an explicit interval and the default limit for a number', () => {
      expect(resolveAckExtension(1_500, undefined)).toEqual(extension(1_500));
    });

    it('should extend at half the ack_wait for true', () => {
      // Given: ack_wait of 30s in nanoseconds
      const ackWaitNanos = 30 * 1_000 * 1_000_000;

      // When + Then
      expect(resolveAckExtension(true, ackWaitNanos)).toEqual(extension(15_000));
    });

    it('should take interval and maxDuration from the object form', () => {
      // Given
      const interval = faker.number.int({ min: 1_000, max: 10_000 });
      const maxDuration = faker.number.int({ min: 60_000, max: 3_600_000 });

      // When + Then
      expect(resolveAckExtension({ interval, maxDuration }, undefined)).toEqual(
        extension(interval, maxDuration),
      );
    });

    it('should derive the interval from ack_wait when the object omits it', () => {
      // Given: ack_wait of 10s
      const ackWaitNanos = 10 * 1_000 * 1_000_000;

      // When + Then
      expect(resolveAckExtension({ maxDuration: 60_000 }, ackWaitNanos)).toEqual(
        extension(5_000, 60_000),
      );
    });

    it('should accept Infinity as maxDuration to remove the limit', () => {
      expect(resolveAckExtension({ maxDuration: Number.POSITIVE_INFINITY }, undefined)).toEqual(
        extension(5_000, Number.POSITIVE_INFINITY),
      );
    });
  });

  describe('edge cases', () => {
    it('should return null when config is false', () => {
      expect(resolveAckExtension(false, undefined)).toBeNull();
    });

    it('should return null when config is undefined (default off)', () => {
      expect(resolveAckExtension(undefined, 1_000_000_000)).toBeNull();
    });

    it('should floor non-integer numeric configs', () => {
      expect(resolveAckExtension(1_500.7, undefined)?.intervalMs).toBe(1_500);
    });

    it('should return null when given a non-finite number (NaN / Infinity)', () => {
      expect(resolveAckExtension(Number.NaN, 1_000_000)).toBeNull();
      expect(resolveAckExtension(Number.POSITIVE_INFINITY, 1_000_000)).toBeNull();
    });

    it('should return null when the explicit number is zero or negative', () => {
      expect(resolveAckExtension(0, 1_000_000)).toBeNull();
      expect(resolveAckExtension(-50, 1_000_000)).toBeNull();
    });

    it('should fall back to the default interval when ack_wait is unknown', () => {
      expect(resolveAckExtension(true, undefined)?.intervalMs).toBe(5_000);
    });

    it('should clamp the auto interval to the 500ms minimum', () => {
      // Given: ack_wait of 100ms, half of it under the floor
      const ackWaitNanos = 100 * 1_000_000;

      // When + Then
      expect(resolveAckExtension(true, ackWaitNanos)?.intervalMs).toBe(500);
    });
  });

  describe('error paths', () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'should reject interval %s in the object form',
      (interval) => {
        expect(() => resolveAckExtension({ interval }, undefined)).toThrow(/ackExtension\.interval/);
      },
    );

    it.each([0, -1, Number.NaN])('should reject maxDuration %s', (maxDuration) => {
      expect(() => resolveAckExtension({ maxDuration }, undefined)).toThrow(
        /ackExtension\.maxDuration/,
      );
    });
  });
});

describe('startAckExtensionTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Drain any in-flight pool entries so a leaked timer doesn't surface
    // as flake in the next test.
    vi.useRealTimers();
  });

  it('should return null when ack extension is disabled', () => {
    expect(startAckExtensionTimer(target(), null)).toBeNull();
  });

  it('should return null when the interval is zero or negative', () => {
    expect(startAckExtensionTimer(target(), extension(0))).toBeNull();
    expect(startAckExtensionTimer(target(), extension(-100))).toBeNull();
  });

  it('should call msg.working() repeatedly at the configured interval', () => {
    // Given
    const msg = target();
    const cancel = startAckExtensionTimer(msg, extension(1_000));

    expect(cancel).toBeDefined();

    // When: advance two intervals
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);

    // Then: `working()` fires once per interval
    expect(msg.working).toHaveBeenCalledTimes(2);

    cancel?.();
  });

  it('should stop calling working() once cancel is invoked', () => {
    // Given
    const msg = target();
    const cancel = startAckExtensionTimer(msg, extension(1_000))!;

    vi.advanceTimersByTime(1_000);
    expect(msg.working).toHaveBeenCalledTimes(1);

    // When
    cancel();
    vi.advanceTimersByTime(5_000);

    // Then: no further calls
    expect(msg.working).toHaveBeenCalledTimes(1);
  });

  it('should be a no-op on repeated cancel calls', () => {
    // Given
    const msg = target();
    const cancel = startAckExtensionTimer(msg, extension(1_000))!;

    // When + Then: second cancel must not throw or affect state
    expect(() => {
      cancel();
      cancel();
    }).not.toThrow();
  });

  it('should swallow exceptions thrown by working() so a degraded NATS connection does not crash the pool', () => {
    // Given
    const failing = {
      subject: faker.lorem.word(),
      working: vi.fn().mockImplementation(() => {
        throw new Error('connection degraded');
      }),
    };
    const healthy = target();

    const cancelFailing = startAckExtensionTimer(failing, extension(1_000))!;
    const cancelHealthy = startAckExtensionTimer(healthy, extension(1_000))!;

    // When: fire the shared timer
    vi.advanceTimersByTime(1_000);

    // Then: failing entry doesn't poison the healthy one
    expect(failing.working).toHaveBeenCalled();
    expect(healthy.working).toHaveBeenCalled();

    cancelFailing();
    cancelHealthy();
  });

  it('should drive multiple registered messages from a single shared timer', () => {
    // Given: two messages with the same interval
    const msgA = target();
    const msgB = target();
    const cancelA = startAckExtensionTimer(msgA, extension(1_000))!;
    const cancelB = startAckExtensionTimer(msgB, extension(1_000))!;

    // When
    vi.advanceTimersByTime(1_000);

    // Then: both fired in the same tick
    expect(msgA.working).toHaveBeenCalledTimes(1);
    expect(msgB.working).toHaveBeenCalledTimes(1);

    cancelA();
    cancelB();
  });

  it('should re-schedule for the earlier deadline when a tighter entry is added', () => {
    // Given: an existing entry with a 5s interval, then a 1s entry
    // joining mid-flight. The 1s entry must fire before the 5s one.
    const longInterval = target();
    const shortInterval = target();

    const cancelLong = startAckExtensionTimer(longInterval, extension(5_000))!;

    vi.advanceTimersByTime(500); // partway into the 5s wait

    const cancelShort = startAckExtensionTimer(shortInterval, extension(1_000))!;

    // When: advance past the short interval but before the long one
    vi.advanceTimersByTime(1_000);

    // Then
    expect(shortInterval.working).toHaveBeenCalledTimes(1);
    expect(longInterval.working).toHaveBeenCalledTimes(0);

    cancelLong();
    cancelShort();
  });

  it('should clear the shared timer once the last entry is canceled', () => {
    // Given
    const msg = target();
    const cancel = startAckExtensionTimer(msg, extension(1_000))!;

    // When
    cancel();

    // Then: pool internal state observable via the test export
    expect(_ackExtensionPoolForTest).toBeDefined();
    // Subsequent timer advance must not fire any callbacks because the
    // entry has been removed and the timer cleared.
    vi.advanceTimersByTime(10_000);
    expect(msg.working).not.toHaveBeenCalled();
  });
  it('should stop extending once maxDuration has passed', () => {
    // Given: a 1s interval capped at 3s
    const msg = target();
    const cancel = startAckExtensionTimer(msg, extension(1_000, 3_000))!;

    // When: well past the cap
    vi.advanceTimersByTime(10_000);

    // Then: extended only while under the cap
    expect(msg.working).toHaveBeenCalledTimes(2);

    cancel();
  });

  it('should warn with the subject when it stops at maxDuration', () => {
    // Given
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const msg = target();

    startAckExtensionTimer(msg, extension(1_000, 3_000));

    // When
    vi.advanceTimersByTime(3_000);

    // Then: one warning that names the message and the limit
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(msg.subject);
    expect(warn.mock.calls[0]?.[0]).toContain('3000ms');
  });

  it('should not warn when the handler finishes before maxDuration', () => {
    // Given
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const cancel = startAckExtensionTimer(target(), extension(1_000, 3_000))!;

    // When
    vi.advanceTimersByTime(2_000);
    cancel();
    vi.advanceTimersByTime(5_000);

    // Then
    expect(warn).not.toHaveBeenCalled();
  });

  it('should keep extending without a limit when maxDuration is Infinity', () => {
    // Given
    const msg = target();
    const cancel = startAckExtensionTimer(msg, extension(1_000, Number.POSITIVE_INFINITY))!;

    // When: an hour of handler time
    vi.advanceTimersByTime(3_600_000);

    // Then
    expect(msg.working).toHaveBeenCalledTimes(3_600);

    cancel();
  });
});

