import { Logger } from '@nestjs/common';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { ConnectionProvider } from '../../connection';
import { ConnectionRegistry } from '../../connection/connection-registry';
import type { ConnectionScope } from '../../connection/connection.types';
import { EventBus } from '../../hooks';
import type { ResolvedConnectionOptions } from '../../interfaces';
import { TransportEvent } from '../../interfaces';
import { JetstreamStrategy } from '../../server/strategy';
import { ShutdownManager } from '../shutdown.manager';

interface ScopeStub {
  scope: ConnectionScope;
  connection: Mocked<ConnectionProvider>;
  strategy: Mocked<JetstreamStrategy>;
}

const makeScope = (
  name: string,
  overrides: Partial<ResolvedConnectionOptions> = {},
  shutdownImpl?: () => Promise<void>,
): ScopeStub => {
  const connection = createMock<ConnectionProvider>({
    shutdown: vi.fn(shutdownImpl ?? ((): Promise<void> => Promise.resolve())),
    forceClose: vi.fn((): Promise<void> => Promise.resolve()),
  });
  const strategy = createMock<JetstreamStrategy>({
    whenIdle: vi.fn((): Promise<void> => Promise.resolve()),
  });
  const scope = createMock<ConnectionScope>({
    name,
    critical: true,
    connection,
    strategy,
    options: createMock<ResolvedConnectionOptions>(overrides),
  });

  return { scope, connection, strategy };
};

const registryOf = (stubs: ScopeStub[]): ConnectionRegistry =>
  new ConnectionRegistry(
    new Map(stubs.map((s) => [s.scope.name, s.scope])),
    stubs[0]?.scope.name ?? 'default',
  );

describe(ShutdownManager, () => {
  let sut: ShutdownManager;

  let primary: ScopeStub;
  let eventBus: Mocked<EventBus>;
  let timeout: number;

  beforeEach(() => {
    primary = makeScope('default');
    eventBus = createMock<EventBus>();
    timeout = faker.number.int({ min: 1000, max: 30000 });
    sut = new ShutdownManager(registryOf([primary]), eventBus, timeout);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe('shutdown()', () => {
    describe('happy path', () => {
      it('should close the strategy and drain the connection', async () => {
        // Given a single configured connection
        // When shutdown runs
        await sut.shutdown();

        // Then the strategy stops accepting and the connection drains
        expect(primary.strategy.close).toHaveBeenCalled();
        expect(primary.connection.shutdown).toHaveBeenCalled();
      });

      it('should emit ShutdownStart and ShutdownComplete events', async () => {
        // Given a single configured connection
        // When shutdown runs
        await sut.shutdown();

        // Then lifecycle events are emitted
        expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownStart);
        expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownComplete);
      });

      it('should drain a connection that has no strategy', async () => {
        // Given a publisher-only connection
        const publisher = makeScope('publisher');
        const scope = createMock<ConnectionScope>({
          name: 'publisher',
          critical: true,
          connection: publisher.connection,
          strategy: null,
          options: createMock<ResolvedConnectionOptions>({}),
        });

        sut = new ShutdownManager(
          new ConnectionRegistry(new Map([['publisher', scope]]), 'publisher'),
          eventBus,
          timeout,
        );

        // When shutdown runs
        await sut.shutdown();

        // Then it still drains
        expect(publisher.connection.shutdown).toHaveBeenCalled();
      });
    });

    describe('two-phase ordering', () => {
      it('should close every strategy before draining any connection', async () => {
        // Given two connections that record the order of their calls
        const order: string[] = [];
        const a = makeScope('a', {}, async () => {
          order.push('drain:a');
        });
        const b = makeScope('b', {}, async () => {
          order.push('drain:b');
        });

        a.strategy.close.mockImplementation(() => {
          order.push('close:a');
        });
        b.strategy.close.mockImplementation(() => {
          order.push('close:b');
        });

        sut = new ShutdownManager(registryOf([a, b]), eventBus, timeout);

        // When shutdown runs
        await sut.shutdown();

        // Then no drain starts before every strategy has stopped accepting,
        // otherwise one connection keeps taking work while its peers wind down
        expect(order.slice(0, 2).toSorted()).toEqual(['close:a', 'close:b']);
        expect(order.slice(2).toSorted()).toEqual(['drain:a', 'drain:b']);
      });

      it('should wait for in-flight handlers after closing and before draining', async () => {
        // Given a connection whose handlers are still running when it closes
        const order: string[] = [];
        const { promise: handlersDone, resolve: finishHandlers } = Promise.withResolvers<void>();
        const busy = makeScope('busy', {}, async () => {
          order.push('drain');
        });

        busy.strategy.close.mockImplementation(() => {
          order.push('close');
        });
        busy.strategy.whenIdle.mockImplementation(async () => {
          await handlersDone;
          order.push('idle');
        });
        sut = new ShutdownManager(registryOf([busy]), eventBus, timeout);

        // When shutdown starts and the handlers finish afterwards
        const pending = sut.shutdown();

        await Promise.resolve();
        expect(busy.connection.shutdown).not.toHaveBeenCalled();
        finishHandlers();
        await pending;

        // Then the drain starts only once the handlers settled
        expect(order).toEqual(['close', 'idle', 'drain']);
      });
    });

    describe('idempotency', () => {
      it('should execute shutdown only once on repeated calls', async () => {
        // Given concurrent shutdown requests
        // When shutdown is called several times
        await Promise.all([sut.shutdown(), sut.shutdown(), sut.shutdown()]);

        // Then the sequence runs exactly once
        expect(primary.strategy.close).toHaveBeenCalledTimes(1);
        expect(primary.connection.shutdown).toHaveBeenCalledTimes(1);
      });
    });

    describe('edge cases', () => {
      it('should clear the safety timeout when the drain finishes first', async () => {
        // Given a connection that drains immediately
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

        // When shutdown runs
        await sut.shutdown();

        // Then the timer is released
        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
      });

      it('should force-close a hung connection after its own budget', async () => {
        // Given a connection that never finishes draining and a short budget
        vi.useFakeTimers();

        const stuck = makeScope(
          'stuck',
          { shutdownTimeout: 100 },
          () => new Promise<void>(() => {}),
        );

        sut = new ShutdownManager(registryOf([stuck]), eventBus, 30_000);

        // When shutdown starts and the per-connection budget elapses
        const pending = sut.shutdown();

        await vi.advanceTimersByTimeAsync(99);
        expect(stuck.connection.forceClose).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        // Then the connection is closed and shutdown completes without the root budget
        await expect(pending).resolves.toBeUndefined();
        expect(stuck.connection.forceClose).toHaveBeenCalledOnce();
        expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownComplete);
      });

      it('should keep the last 2 seconds of the budget for the drain when handlers outlast it', async () => {
        // Given handlers that never finish and a drain that takes one second
        vi.useFakeTimers();

        const budget = 10_000;
        const hung = makeScope(
          'hung',
          { shutdownTimeout: budget },
          () => new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        );

        hung.strategy.whenIdle.mockReturnValue(new Promise<void>(() => {}));
        sut = new ShutdownManager(registryOf([hung]), eventBus, 30_000);

        // When shutdown starts
        const pending = sut.shutdown();
        let done = false;

        void pending.then(() => {
          done = true;
        });

        // Then the drain starts once only the reserve is left
        await vi.advanceTimersByTimeAsync(budget - 2_001);
        expect(hung.connection.shutdown).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(hung.connection.shutdown).toHaveBeenCalledOnce();

        // And shutdown waits for that drain instead of abandoning it
        await vi.advanceTimersByTimeAsync(999);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(true);
        expect(hung.connection.forceClose).not.toHaveBeenCalled();
      });

      it('should keep half of a small budget for the drain', async () => {
        // Given handlers that never finish and a one-second budget
        vi.useFakeTimers();

        const hung = makeScope('hung', { shutdownTimeout: 1_000 });

        hung.strategy.whenIdle.mockReturnValue(new Promise<void>(() => {}));
        sut = new ShutdownManager(registryOf([hung]), eventBus, 30_000);

        // When shutdown starts
        const pending = sut.shutdown();

        // Then the drain starts halfway through the budget
        await vi.advanceTimersByTimeAsync(499);
        expect(hung.connection.shutdown).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(hung.connection.shutdown).toHaveBeenCalledOnce();
        await expect(pending).resolves.toBeUndefined();
      });

      it('should give the drain whatever budget the handlers left over', async () => {
        // Given handlers that finish early and a drain that hangs
        vi.useFakeTimers();

        const budget = 10_000;
        const slow = makeScope('slow', { shutdownTimeout: budget }, () => new Promise(() => {}));

        slow.strategy.whenIdle.mockImplementation(
          () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
        );
        sut = new ShutdownManager(registryOf([slow]), eventBus, 30_000);

        // When shutdown starts
        const pending = sut.shutdown();

        // Then the drain runs until the whole budget is spent, then the connection is closed
        await vi.advanceTimersByTimeAsync(budget - 1);
        expect(slow.connection.shutdown).toHaveBeenCalledOnce();
        expect(slow.connection.forceClose).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toBeUndefined();
        expect(slow.connection.forceClose).toHaveBeenCalledOnce();
      });

      it('should keep going when one strategy throws while closing', async () => {
        // Given a strategy whose close() throws
        const failing = makeScope('failing');
        const healthy = makeScope('healthy');

        failing.strategy.close.mockImplementation(() => {
          throw new Error('close exploded');
        });

        sut = new ShutdownManager(registryOf([failing, healthy]), eventBus, timeout);

        // When shutdown runs
        await expect(sut.shutdown()).resolves.toBeUndefined();

        // Then the other connection still closed and drained, and the sequence
        // completed rather than poisoning the shared shutdown promise
        expect(healthy.strategy.close).toHaveBeenCalled();
        expect(healthy.connection.shutdown).toHaveBeenCalled();
        expect(failing.connection.shutdown).toHaveBeenCalled();
        expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownComplete);
      });

      it('should still drain when waiting for in-flight handlers fails', async () => {
        // Given a strategy whose in-flight wait rejects
        primary.strategy.whenIdle.mockRejectedValue(new Error(faker.lorem.sentence()));

        // When shutdown runs
        await expect(sut.shutdown()).resolves.toBeUndefined();

        // Then the connection is drained regardless
        expect(primary.connection.shutdown).toHaveBeenCalled();
      });

      it('should keep draining the rest when one connection throws', async () => {
        // Given a connection whose drain rejects
        const failing = makeScope('failing', {}, () => Promise.reject(new Error('boom')));
        const healthy = makeScope('healthy');

        sut = new ShutdownManager(registryOf([failing, healthy]), eventBus, timeout);

        // When shutdown runs
        await sut.shutdown();

        // Then the healthy connection still drained and shutdown resolved
        expect(healthy.connection.shutdown).toHaveBeenCalled();
        expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownComplete);
      });
    });
  });
});

describe('ShutdownManager logging', () => {
  afterEach(vi.resetAllMocks);

  it('should name the connection that failed to drain', async () => {
    // Given a connection whose drain rejects
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const failing = makeScope('analytics', {}, () => Promise.reject(new Error('boom')));

    const sut = new ShutdownManager(registryOf([failing]), createMock<EventBus>(), 1_000);

    // When shutdown runs
    await sut.shutdown();

    // Then the warning identifies which connection failed
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('analytics'));
  });
});
