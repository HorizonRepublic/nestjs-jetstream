import { Logger } from '@nestjs/common';

import type { JsMsg } from '@nats-io/jetstream';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { ConcurrencyGate } from '../concurrency-gate';

const makeMsg = (subject: string): JsMsg => createMock<JsMsg>({ subject });

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
};

/** A gate whose only slot is held by a handler that settles on `release()`. */
interface HungGate {
  readonly sut: ConcurrencyGate;
  readonly stopTimer: Mock;
  release(): void;
}

describe(ConcurrencyGate, () => {
  afterEach(vi.resetAllMocks);

  describe('routing', () => {
    it('should run synchronous routes without consuming a slot afterwards', () => {
      // Given
      const route = vi.fn().mockReturnValue(undefined);
      const sut = new ConcurrencyGate(1, route, null, createMock<Logger>(), 'ev');

      // When
      sut.push(makeMsg('a'));
      sut.push(makeMsg('b'));

      // Then: both routed immediately, nothing parked
      expect(route).toHaveBeenCalledTimes(2);
    });

    it('should park messages beyond the limit and drain them FIFO', async () => {
      // Given: maxActive 1, async route we settle manually
      const gates: Deferred[] = [];
      const order: string[] = [];
      const route = vi.fn((msg: JsMsg) => {
        order.push(msg.subject);
        const d = deferred();

        gates.push(d);

        return d.promise;
      });
      const sut = new ConcurrencyGate(1, route, null, createMock<Logger>(), 'ev');

      // When: three messages arrive while the first is in flight
      sut.push(makeMsg('first'));
      sut.push(makeMsg('second'));
      sut.push(makeMsg('third'));

      expect(order).toEqual(['first']);

      gates[0]!.resolve();
      await new Promise(process.nextTick);

      expect(order).toEqual(['first', 'second']);

      gates[1]!.resolve();
      await new Promise(process.nextTick);

      // Then: strict FIFO
      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('should not leak the slot when a route throws synchronously', () => {
      // Given
      const route = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('boom');
        })
        .mockReturnValue(undefined);
      const sut = new ConcurrencyGate(1, route, null, createMock<Logger>(), 'ev');

      // When
      sut.push(makeMsg('a'));
      sut.push(makeMsg('b'));

      // Then: the second message still routes
      expect(route).toHaveBeenCalledTimes(2);
    });
  });

  describe('backlog warning', () => {
    it('should warn once when the backlog crosses the threshold and re-arm after draining', async () => {
      // Given: one message in flight, a thousand parked
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const d = deferred();
      const route = vi.fn().mockReturnValueOnce(d.promise).mockReturnValue(undefined);
      const sut = new ConcurrencyGate(1, route, null, new Logger('test'), 'ev');

      sut.push(makeMsg('in-flight'));

      // When: cross the threshold
      for (let i = 0; i < 1_000; i += 1) {
        sut.push(makeMsg(`parked-${i}`));
      }

      // Then: a single warning despite further arrivals
      expect(warnSpy).toHaveBeenCalledOnce();

      sut.push(makeMsg('parked-final'));

      expect(warnSpy).toHaveBeenCalledOnce();

      // When: drain everything (remaining routes are synchronous)
      d.resolve();
      await new Promise(process.nextTick);

      // Then: warning re-arms once the backlog is below the threshold again
      sut.push(makeMsg('round-two'));

      expect(route).toHaveBeenCalledTimes(1_003);
    });
  });

  describe('dispose()', () => {
    it('should stop parked ack-extension timers and drop the backlog', () => {
      // Given: limit 0 parks everything; every parked message gets a timer
      const stopTimer = vi.fn();
      const parkTimer = vi.fn().mockReturnValue(stopTimer);
      const route = vi.fn();
      const sut = new ConcurrencyGate(0, route, parkTimer, createMock<Logger>(), 'ev');

      sut.push(makeMsg('a'));
      sut.push(makeMsg('b'));

      // When
      sut.dispose();

      // Then: both timers stopped, nothing was ever routed
      expect(stopTimer).toHaveBeenCalledTimes(2);

      expect(route).not.toHaveBeenCalled();
    });
  });

  describe('stalled handlers', () => {
    const STALL_MS = 60_000;

    const hungGate = (): HungGate => {
      const hung = deferred();
      const stopTimer = vi.fn();
      const route = vi.fn().mockReturnValue(hung.promise);
      const sut = new ConcurrencyGate(
        1,
        route,
        vi.fn().mockReturnValue(stopTimer),
        createMock<Logger>(),
        'ev',
        STALL_MS,
      );

      return { sut, stopTimer, release: hung.resolve };
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should hand the backlog back once no slot frees within the stall limit', async () => {
      // Given a hung handler holding the only slot and two parked messages
      vi.useFakeTimers();
      const { sut, stopTimer } = hungGate();
      const parked = [makeMsg('b'), makeMsg('c')];

      sut.push(makeMsg('a'));
      for (const msg of parked) sut.push(msg);

      // When the stall limit passes
      await vi.advanceTimersByTimeAsync(STALL_MS);

      // Then the parked messages stop being extended and go back to the server
      expect(stopTimer).toHaveBeenCalledTimes(2);
      for (const msg of parked) expect(msg.nak).toHaveBeenCalledOnce();
    });

    it('should hand back messages arriving while stalled, until a slot frees', async () => {
      // Given a gate already stalled
      vi.useFakeTimers();
      const { sut, release } = hungGate();

      sut.push(makeMsg('a'));
      await vi.advanceTimersByTimeAsync(STALL_MS);

      // When a message arrives during the stall
      const during = makeMsg('during');

      sut.push(during);

      // Then it goes straight back
      expect(during.nak).toHaveBeenCalledOnce();

      // And once the slot frees, new messages park again
      release();
      await vi.advanceTimersByTimeAsync(0);
      sut.push(makeMsg('busy'));
      const after = makeMsg('after');

      sut.push(after);
      expect(after.nak).not.toHaveBeenCalled();
    });

    it('should keep the backlog while handlers make progress', async () => {
      // Given a backlog behind a handler that is not hung yet
      vi.useFakeTimers();
      const { sut } = hungGate();
      const parked = makeMsg('b');

      sut.push(makeMsg('a'));
      sut.push(parked);

      // When less than the stall limit passes
      await vi.advanceTimersByTimeAsync(STALL_MS - 1);

      // Then it is still waiting for the slot
      expect(parked.nak).not.toHaveBeenCalled();
    });
  });
});
