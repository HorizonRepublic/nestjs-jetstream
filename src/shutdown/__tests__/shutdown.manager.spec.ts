import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';

import { ConnectionProvider } from '../../connection';
import { EventBus } from '../../hooks';
import { TransportEvent } from '../../interfaces';
import { JetstreamStrategy } from '../../server/strategy';

import { ShutdownManager } from '../shutdown.manager';

describe(ShutdownManager, () => {
  let sut: ShutdownManager;

  let connection: Mocked<ConnectionProvider>;
  let eventBus: Mocked<EventBus>;
  let timeout: number;

  beforeEach(() => {
    connection = createMock<ConnectionProvider>({
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    eventBus = createMock<EventBus>();
    timeout = faker.number.int({ min: 1000, max: 30000 });
    sut = new ShutdownManager(connection, eventBus, timeout);
  });

  afterEach(vi.resetAllMocks);

  describe('shutdown()', () => {
    describe('happy path', () => {
      describe('when strategy is provided', () => {
        it('should close strategy and drain connection', async () => {
          // Given: a strategy
          const strategy = createMock<JetstreamStrategy>();

          // When: shutdown
          await sut.shutdown(strategy);

          // Then: strategy closed, connection drained
          expect(strategy.close).toHaveBeenCalled();
          expect(connection.shutdown).toHaveBeenCalled();
        });

        it('should emit ShutdownStart and ShutdownComplete events', async () => {
          // Given: a strategy
          const strategy = createMock<JetstreamStrategy>();

          // When: shutdown
          await sut.shutdown(strategy);

          // Then: lifecycle events emitted in order
          expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownStart);
          expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownComplete);
        });
      });

      describe('when no strategy is provided', () => {
        it('should still drain connection and emit events', async () => {
          // When: shutdown without strategy
          await sut.shutdown();

          // Then: connection drained, events emitted
          expect(connection.shutdown).toHaveBeenCalled();
          expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownStart);
          expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownComplete);
        });
      });
    });

    describe('idempotency', () => {
      it('should execute shutdown only once on repeated calls', async () => {
        // Given: a strategy
        const strategy = createMock<JetstreamStrategy>();

        // When: shutdown called multiple times concurrently
        await Promise.all([sut.shutdown(strategy), sut.shutdown(strategy), sut.shutdown(strategy)]);

        // Then: strategy closed exactly once, connection drained exactly once
        expect(strategy.close).toHaveBeenCalledTimes(1);
        expect(connection.shutdown).toHaveBeenCalledTimes(1);
      });
    });

    describe('pre-drain hooks', () => {
      it('should execute registered hooks before draining connection', async () => {
        // Given: a hook registered
        const executionOrder: string[] = [];

        sut.registerPreDrainHook(async () => {
          executionOrder.push('hook');
        });
        connection.shutdown.mockImplementation(async () => {
          executionOrder.push('drain');
        });

        // When
        await sut.shutdown();

        // Then: hook ran before drain
        expect(executionOrder).toEqual(['hook', 'drain']);
      });

      it('should execute multiple hooks in registration order', async () => {
        // Given: two hooks
        const order: number[] = [];

        sut.registerPreDrainHook(async () => {
          order.push(1);
        });
        sut.registerPreDrainHook(async () => {
          order.push(2);
        });

        // When
        await sut.shutdown();

        // Then
        expect(order).toEqual([1, 2]);
      });

      it('should continue shutdown when a hook throws', async () => {
        // Given: a failing hook followed by a passing hook
        const hookRan = vi.fn();

        sut.registerPreDrainHook(async () => {
          throw new Error('hook failure');
        });
        sut.registerPreDrainHook(async () => {
          hookRan();
        });

        // When
        await sut.shutdown();

        // Then: second hook ran, connection drained
        expect(hookRan).toHaveBeenCalled();
        expect(connection.shutdown).toHaveBeenCalled();
      });
    });

    describe('edge cases', () => {
      describe('when connection.shutdown() completes before timeout', () => {
        it('should clear the safety timeout', async () => {
          // Given: connection.shutdown resolves immediately
          const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

          // When: shutdown
          await sut.shutdown();

          // Then: timeout should have been cleared
          expect(clearTimeoutSpy).toHaveBeenCalled();
          clearTimeoutSpy.mockRestore();
        });
      });

      describe('when connection.shutdown() hangs past timeout', () => {
        it('should resolve after timeout via Promise.race', async () => {
          vi.useFakeTimers();

          // Given: connection.shutdown never resolves
          connection.shutdown.mockReturnValue(new Promise(() => {}));
          sut = new ShutdownManager(connection, eventBus, 5000);

          // When: shutdown starts, then timeout fires
          const promise = sut.shutdown();

          vi.advanceTimersByTime(5000);
          await promise;

          // Then: resolved via timeout, events emitted
          expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownComplete);

          vi.useRealTimers();
        });
      });
    });
  });
});
