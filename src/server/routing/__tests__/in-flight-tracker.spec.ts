import { faker } from '@faker-js/faker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InFlightTracker } from '../in-flight-tracker';

describe(InFlightTracker, () => {
  let sut: InFlightTracker;

  beforeEach(() => {
    sut = new InFlightTracker();
  });

  afterEach(vi.resetAllMocks);

  /** Whether `promise` has settled once pending microtasks ran. */
  const hasSettled = async (promise: Promise<void>): Promise<boolean> => {
    let settled = false;

    void promise.then(() => {
      settled = true;
    });
    await new Promise(process.nextTick);

    return settled;
  };

  describe('happy path', () => {
    it('should resolve whenIdle once tracked work settles', async () => {
      // Given tracked work still running
      const { promise: work, resolve: finish } = Promise.withResolvers<void>();

      sut.track(work);

      // When waiting for idle
      const idle = sut.whenIdle();

      // Then it resolves only after the work finished
      expect(await hasSettled(idle)).toBe(false);
      finish();
      expect(await hasSettled(idle)).toBe(true);
      expect(sut.size).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should resolve whenIdle at once when nothing is tracked', async () => {
      expect(await hasSettled(sut.whenIdle())).toBe(true);
    });

    it('should also wait for work tracked while already waiting', async () => {
      // Given one unit of work and a wait already in progress
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();

      sut.track(first.promise);

      const idle = sut.whenIdle();

      sut.track(second.promise);

      // When only the first unit finishes
      first.resolve();

      // Then the wait goes on until the second one finishes too
      expect(await hasSettled(idle)).toBe(false);
      second.resolve();
      expect(await hasSettled(idle)).toBe(true);
    });
  });

  describe('error paths', () => {
    it('should count rejected work as settled without rejecting whenIdle', async () => {
      // Given tracked work that fails
      const work = Promise.reject(new Error(faker.lorem.sentence()));

      work.catch(() => undefined);
      sut.track(work);

      // When / Then
      await expect(sut.whenIdle()).resolves.toBeUndefined();
      expect(sut.size).toBe(0);
    });
  });
});
