import type { JsMsg } from '@nats-io/jetstream';

import { createMock } from '@golevelup/ts-vitest';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RETRY_DELAYS_MS } from '../../jetstream.constants';
import { resolveRetryDelays, retryDelayFor } from '../retry-delay';

const msgWithDeliveryCount = (deliveryCount: number): JsMsg =>
  createMock<JsMsg>({ info: { deliveryCount } } as Partial<JsMsg>);

describe('resolveRetryDelays', () => {
  it('should fall back to the defaults when unset', () => {
    // Given no configuration / When resolved / Then the shipped curve applies
    expect(resolveRetryDelays(undefined)).toEqual(DEFAULT_RETRY_DELAYS_MS);
  });

  it('should use the configured curve as given', () => {
    // Given an explicit curve
    const delays = [100, 250, 500];

    // When / Then
    expect(resolveRetryDelays(delays)).toEqual(delays);
  });

  it('should return an empty curve for false', () => {
    // Given redelivery pacing turned off
    expect(resolveRetryDelays(false)).toEqual([]);
  });

  it('should drop entries that are not positive finite numbers', () => {
    // Given a curve with junk in it
    expect(resolveRetryDelays([100, 0, -5, Number.NaN, Infinity, 200])).toEqual([100, 200]);
  });
});

describe('retryDelayFor', () => {
  it('should pick the first delay for the first delivery', () => {
    // Given the first attempt
    const msg = msgWithDeliveryCount(1);

    // When / Then
    expect(retryDelayFor([2_000, 10_000], msg)).toBe(2_000);
  });

  it('should advance through the curve with the delivery count', () => {
    // Given the second attempt
    const msg = msgWithDeliveryCount(2);

    // When / Then
    expect(retryDelayFor([2_000, 10_000], msg)).toBe(10_000);
  });

  it('should repeat the last delay once the curve runs out', () => {
    // Given more attempts than the curve has entries
    const msg = msgWithDeliveryCount(9);

    // When / Then
    expect(retryDelayFor([2_000, 10_000], msg)).toBe(10_000);
  });

  it('should request immediate redelivery for an empty curve', () => {
    // Given pacing turned off
    const msg = msgWithDeliveryCount(1);

    // When / Then
    expect(retryDelayFor([], msg)).toBeUndefined();
  });
});
