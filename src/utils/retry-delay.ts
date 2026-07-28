import type { JsMsg } from '@nats-io/jetstream';

import type { RetryConfig } from '../interfaces';
import { DEFAULT_RETRY_DELAYS_MS } from '../jetstream.constants';

/**
 * Resolve the redelivery delay curve for one stream kind.
 *
 * @param config - `false` -> nak immediately, an array -> use it, otherwise the defaults.
 * @returns Delays in milliseconds, empty when redelivery should be immediate.
 */
export const resolveRetryDelays = (config: RetryConfig | undefined): readonly number[] => {
  if (config === false) return [];
  if (config === undefined) return DEFAULT_RETRY_DELAYS_MS;

  return config.filter((ms) => Number.isFinite(ms) && ms > 0);
};

/**
 * Pick the delay for the redelivery that follows this attempt. The last entry
 * repeats once the curve is exhausted, so a longer `max_deliver` keeps the
 * final spacing instead of falling back to an immediate nak.
 *
 * @param delays - Curve from {@link resolveRetryDelays}.
 * @param msg - The message being naked; its delivery count picks the entry.
 * @returns Delay in milliseconds, or `undefined` for immediate redelivery.
 */
export const retryDelayFor = (delays: readonly number[], msg: JsMsg): number | undefined => {
  if (delays.length === 0) return undefined;

  // deliveryCount is 1 on the first attempt, so it doubles as the 1-based
  // index of the retry this nak is scheduling.
  const index = Math.max(0, msg.info.deliveryCount - 1);

  return delays[Math.min(index, delays.length - 1)];
};
