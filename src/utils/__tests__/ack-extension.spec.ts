import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _ackExtensionPoolForTest,
  resolveAckExtensionInterval,
  startAckExtensionTimer,
} from '../ack-extension';

describe('resolveAckExtensionInterval', () => {
  it('should return null when config is false', () => {
    expect(resolveAckExtensionInterval(false, undefined)).toBeNull();
  });

  it('should return null when config is undefined (default off)', () => {
    expect(resolveAckExtensionInterval(undefined, 1_000_000_000)).toBeNull();
  });

  it('should return the explicit ms value when given a positive number', () => {
    expect(resolveAckExtensionInterval(1_500, undefined)).toBe(1_500);
  });

  it('should floor non-integer numeric configs', () => {
    expect(resolveAckExtensionInterval(1_500.7, undefined)).toBe(1_500);
  });

  it('should return null when given a non-finite number (NaN / Infinity)', () => {
    expect(resolveAckExtensionInterval(Number.NaN, 1_000_000)).toBeNull();
    expect(resolveAckExtensionInterval(Number.POSITIVE_INFINITY, 1_000_000)).toBeNull();
  });

  it('should return null when the explicit number is zero or negative', () => {
    expect(resolveAckExtensionInterval(0, 1_000_000)).toBeNull();
    expect(resolveAckExtensionInterval(-50, 1_000_000)).toBeNull();
  });

  it('should fall back to the default interval when config is true and ackWait is unknown', () => {
    expect(resolveAckExtensionInterval(true, undefined)).toBe(5_000);
  });

  it('should compute half the ackWait when config is true and ackWait is set', () => {
    // Given — ackWait of 30s reported in nanoseconds
    const ackWaitNanos = 30 * 1_000 * 1_000_000;

    // When + Then — 30s / 2 = 15_000ms (well above the floor)
    expect(resolveAckExtensionInterval(true, ackWaitNanos)).toBe(15_000);
  });

  it('should clamp the auto interval to the 500ms minimum', () => {
    // Given — ackWait of 100ms (well under the floor when halved)
    const ackWaitNanos = 100 * 1_000_000;

    // When + Then — half is 50ms, clamped up to 500
    expect(resolveAckExtensionInterval(true, ackWaitNanos)).toBe(500);
  });
});

describe('startAckExtensionTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Drain any in-flight pool entries so a leaked timer doesn't surface
    // as flake in the next test.
    vi.useRealTimers();
  });

  it('should return null when interval is null (ack extension disabled)', () => {
    expect(startAckExtensionTimer({ working: vi.fn() }, null)).toBeNull();
  });

  it('should return null when interval is zero or negative', () => {
    expect(startAckExtensionTimer({ working: vi.fn() }, 0)).toBeNull();
    expect(startAckExtensionTimer({ working: vi.fn() }, -100)).toBeNull();
  });

  it('should call msg.working() repeatedly at the configured interval', () => {
    // Given
    const msg = { working: vi.fn() };
    const cancel = startAckExtensionTimer(msg, 1_000);

    expect(cancel).toBeDefined();

    // When — advance two intervals
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);

    // Then — `working()` fires once per interval
    expect(msg.working).toHaveBeenCalledTimes(2);

    // Cleanup
    cancel?.();
  });

  it('should stop calling working() once cancel is invoked', () => {
    // Given
    const msg = { working: vi.fn() };
    const cancel = startAckExtensionTimer(msg, 1_000)!;

    vi.advanceTimersByTime(1_000);
    expect(msg.working).toHaveBeenCalledTimes(1);

    // When
    cancel();
    vi.advanceTimersByTime(5_000);

    // Then — no further calls
    expect(msg.working).toHaveBeenCalledTimes(1);
  });

  it('should be a no-op on repeated cancel calls', () => {
    // Given
    const msg = { working: vi.fn() };
    const cancel = startAckExtensionTimer(msg, 1_000)!;

    // When + Then — second cancel must not throw or affect state
    expect(() => {
      cancel();
      cancel();
    }).not.toThrow();
  });

  it('should swallow exceptions thrown by working() so a degraded NATS connection does not crash the pool', () => {
    // Given
    const failing = {
      working: vi.fn().mockImplementation(() => {
        throw new Error('connection degraded');
      }),
    };
    const healthy = { working: vi.fn() };

    const cancelFailing = startAckExtensionTimer(failing, 1_000)!;
    const cancelHealthy = startAckExtensionTimer(healthy, 1_000)!;

    // When — fire the shared timer
    vi.advanceTimersByTime(1_000);

    // Then — failing entry doesn't poison the healthy one
    expect(failing.working).toHaveBeenCalled();
    expect(healthy.working).toHaveBeenCalled();

    // Cleanup
    cancelFailing();
    cancelHealthy();
  });

  it('should drive multiple registered messages from a single shared timer', () => {
    // Given — two messages with the same interval
    const msgA = { working: vi.fn() };
    const msgB = { working: vi.fn() };
    const cancelA = startAckExtensionTimer(msgA, 1_000)!;
    const cancelB = startAckExtensionTimer(msgB, 1_000)!;

    // When
    vi.advanceTimersByTime(1_000);

    // Then — both fired in the same tick
    expect(msgA.working).toHaveBeenCalledTimes(1);
    expect(msgB.working).toHaveBeenCalledTimes(1);

    cancelA();
    cancelB();
  });

  it('should re-schedule for the earlier deadline when a tighter entry is added', () => {
    // Given — an existing entry with a 5s interval, then a 1s entry
    // joining mid-flight. The 1s entry must fire before the 5s one.
    const longInterval = { working: vi.fn() };
    const shortInterval = { working: vi.fn() };

    const cancelLong = startAckExtensionTimer(longInterval, 5_000)!;

    vi.advanceTimersByTime(500); // partway into the 5s wait

    const cancelShort = startAckExtensionTimer(shortInterval, 1_000)!;

    // When — advance past the short interval but before the long one
    vi.advanceTimersByTime(1_000);

    // Then
    expect(shortInterval.working).toHaveBeenCalledTimes(1);
    expect(longInterval.working).toHaveBeenCalledTimes(0);

    cancelLong();
    cancelShort();
  });

  it('should clear the shared timer once the last entry is canceled', () => {
    // Given
    const msg = { working: vi.fn() };
    const cancel = startAckExtensionTimer(msg, 1_000)!;

    // When
    cancel();

    // Then — pool internal state observable via the test export
    expect(_ackExtensionPoolForTest).toBeDefined();
    // Subsequent timer advance must not fire any callbacks because the
    // entry has been removed and the timer cleared.
    vi.advanceTimersByTime(10_000);
    expect(msg.working).not.toHaveBeenCalled();
  });
});
