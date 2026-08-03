import type { ConsumerInfo } from '@nats-io/jetstream';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionProvider } from '../../connection/connection.provider';
import type { ResolvedConnectionOptions } from '../../interfaces';
import type { StreamKind } from '../../interfaces';
import type { ConsumerProvider, MessageProvider, StreamProvider } from '../infrastructure';
import type { EventRouter, PatternRegistry, RpcRouter } from '../routing';
import { JetstreamStrategy } from '../strategy';

const quietRegistry = (registerHandlers: () => void): PatternRegistry =>
  createMock<PatternRegistry>({
    registerHandlers,
    hasEventHandlers: () => false,
    hasBroadcastHandlers: () => false,
    hasOrderedHandlers: () => false,
    hasRpcHandlers: () => false,
    hasMetadata: () => false,
  });

interface SutOverrides {
  streams?: StreamProvider;
  messages?: MessageProvider;
  consumers?: ConsumerProvider;
  eventRouter?: EventRouter;
  rpcRouter?: RpcRouter;
}

const createSut = (
  critical: boolean,
  patterns: PatternRegistry,
  overrides: SutOverrides = {},
): JetstreamStrategy => {
  const connectionName = critical ? 'primary' : 'analytics';
  const options = createMock<ResolvedConnectionOptions>({
    name: 'orders',
    connectionName,
    critical,
  });

  return new JetstreamStrategy(
    options,
    createMock<ConnectionProvider>(),
    patterns,
    overrides.streams ?? createMock(),
    overrides.consumers ?? createMock(),
    overrides.messages ?? createMock(),
    overrides.eventRouter ?? createMock(),
    overrides.rpcRouter ?? createMock(),
    createMock(),
    new Map(),
    undefined,
    {
      name: connectionName,
      defaultName: 'primary',
      known: new Set(['primary', 'analytics']),
      publisherOnly: new Set<string>(),
    },
  );
};

describe('JetstreamStrategy criticality', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('should surface a boot failure through the callback for a critical connection', async () => {
    // Given a critical connection whose registry throws during boot
    const sut = createSut(
      true,
      quietRegistry(() => {
        throw new Error('cluster unreachable');
      }),
    );
    const callback = vi.fn();

    // When listen runs
    await sut.listen(callback);

    // Then the error reaches NestJS
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'cluster unreachable' }),
    );
  });

  it('should complete listen immediately for a non-critical connection', async () => {
    // Given a non-critical connection that fails to boot
    const sut = createSut(
      false,
      quietRegistry(() => {
        throw new Error('cluster unreachable');
      }),
    );
    const callback = vi.fn();

    // When listen runs
    await sut.listen(callback);

    // Then startup is not blocked and no error is reported
    expect(callback).toHaveBeenCalledWith();
    expect(sut.isStarted).toBe(false);
  });

  it('should retry a failed non-critical boot in the background', async () => {
    // Given a boot that fails once then succeeds
    vi.useFakeTimers();

    const registerHandlers = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('cluster unreachable');
      })
      .mockImplementation(() => undefined);

    const sut = createSut(false, quietRegistry(registerHandlers));

    // When listen runs and the backoff elapses
    await sut.listen(vi.fn());
    await vi.advanceTimersByTimeAsync(2_000);

    // Then the boot chain ran again and succeeded
    expect(registerHandlers).toHaveBeenCalledTimes(2);
    expect(sut.isStarted).toBe(true);
  });

  it('should tear down when closed while the boot chain is still running', async () => {
    // Given a connection whose stream provisioning is still in flight
    let releaseBoot: (() => void) | undefined;

    const gate = new Promise<void>((resolve) => {
      releaseBoot = resolve;
    });

    const patterns = createMock<PatternRegistry>({
      registerHandlers: vi.fn(),
      hasEventHandlers: () => true,
      hasBroadcastHandlers: () => false,
      hasOrderedHandlers: () => false,
      hasRpcHandlers: () => false,
      hasMetadata: () => false,
    });
    const streams = createMock<StreamProvider>({ ensureStreams: () => gate });
    const messages = createMock<MessageProvider>();
    const sut = createSut(false, patterns, { streams, messages });

    await sut.listen(vi.fn());

    // When close() lands before provisioning resolves
    sut.close();
    releaseBoot?.();
    await gate;
    await Promise.resolve();
    await Promise.resolve();

    // Then the strategy does not end up "started" with consumers it just began,
    // and consumption is not started after the pipeline was torn down
    expect(sut.isStarted).toBe(false);
    expect(messages.start).not.toHaveBeenCalled();
  });

  it('should tear down routers that subscribed after close() swept through', async () => {
    // Given a boot chain that is awaiting inside consumer provisioning, so the
    // routers only subscribe after close() has already run
    let releaseBoot: (() => void) | undefined;

    const gate = new Promise<Map<StreamKind, ConsumerInfo>>((resolve) => {
      releaseBoot = (): void => {
        resolve(new Map());
      };
    });

    const patterns = createMock<PatternRegistry>({
      registerHandlers: vi.fn(),
      hasEventHandlers: () => true,
      hasBroadcastHandlers: () => false,
      hasOrderedHandlers: () => false,
      hasRpcHandlers: () => false,
      hasMetadata: () => false,
    });
    const consumers = createMock<ConsumerProvider>({ ensureConsumers: () => gate });
    const eventRouter = createMock<EventRouter>();
    const rpcRouter = createMock<RpcRouter>();
    const sut = createSut(false, patterns, { consumers, eventRouter, rpcRouter });

    await sut.listen(vi.fn());

    // When close() lands and the chain then resumes past router startup
    sut.close();
    releaseBoot?.();
    await gate;
    await Promise.resolve();
    await Promise.resolve();

    // Then the routers do not stay subscribed with nothing left to close them
    expect(eventRouter.destroy).toHaveBeenCalled();
    expect(rpcRouter.destroy).toHaveBeenCalled();
  });

  it('should stop retrying once closed', async () => {
    // Given a permanently failing non-critical connection
    vi.useFakeTimers();

    const registerHandlers = vi.fn(() => {
      throw new Error('cluster unreachable');
    });
    const sut = createSut(false, quietRegistry(registerHandlers));

    await sut.listen(vi.fn());
    await vi.advanceTimersByTimeAsync(5_000);

    // When the strategy is closed before the next attempt
    sut.close();

    const attemptsAfterClose = registerHandlers.mock.calls.length;

    await vi.advanceTimersByTimeAsync(120_000);

    // Then no further attempts are made
    expect(registerHandlers).toHaveBeenCalledTimes(attemptsAfterClose);
  });
});
