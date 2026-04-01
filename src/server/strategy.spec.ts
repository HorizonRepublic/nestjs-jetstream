import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import type { NatsConnection } from '@nats-io/transport-node';

import { ConnectionProvider } from '../connection';
import type { JetstreamModuleOptions } from '../interfaces';

import { CoreRpcServer } from './core-rpc.server';
import { ConsumerProvider, MessageProvider, StreamProvider } from './infrastructure';
import { EventRouter, PatternRegistry, RpcRouter } from './routing';
import { JetstreamStrategy } from './strategy';

describe(JetstreamStrategy, () => {
  let sut: JetstreamStrategy;

  let connection: Mocked<ConnectionProvider>;
  let patternRegistry: Mocked<PatternRegistry>;
  let streamProvider: Mocked<StreamProvider>;
  let consumerProvider: Mocked<ConsumerProvider>;
  let messageProvider: Mocked<MessageProvider>;
  let eventRouter: Mocked<EventRouter>;
  let rpcRouter: Mocked<RpcRouter>;
  let coreRpcServer: Mocked<CoreRpcServer>;
  let options: JetstreamModuleOptions;

  beforeEach(() => {
    options = { name: 'test', servers: ['nats://localhost:4222'] };
    connection = createMock<ConnectionProvider>();
    patternRegistry = createMock<PatternRegistry>({
      hasEventHandlers: vi.fn().mockReturnValue(false),
      hasBroadcastHandlers: vi.fn().mockReturnValue(false),
      hasRpcHandlers: vi.fn().mockReturnValue(false),
    });
    streamProvider = createMock<StreamProvider>();
    consumerProvider = createMock<ConsumerProvider>({
      ensureConsumers: vi.fn().mockResolvedValue(new Map()),
    });
    messageProvider = createMock<MessageProvider>();
    eventRouter = createMock<EventRouter>();
    rpcRouter = createMock<RpcRouter>();
    coreRpcServer = createMock<CoreRpcServer>();

    sut = new JetstreamStrategy(
      options,
      connection,
      patternRegistry,
      streamProvider,
      consumerProvider,
      messageProvider,
      eventRouter,
      rpcRouter,
      coreRpcServer,
    );
  });

  afterEach(vi.resetAllMocks);

  describe('listen()', () => {
    it('should ignore second call and not invoke callback', async () => {
      // Given: already started
      const firstCallback = vi.fn();

      await sut.listen(firstCallback);

      expect(firstCallback).toHaveBeenCalledTimes(1);

      // When: listen called again
      const secondCallback = vi.fn();

      await sut.listen(secondCallback);

      // Then: second callback NOT called, handlers not re-registered
      expect(secondCallback).not.toHaveBeenCalled();
      expect(patternRegistry.registerHandlers).toHaveBeenCalledTimes(1);
    });
  });

  describe('close()', () => {
    it('should allow listen() to be called again after close()', async () => {
      // Given: started then closed
      const callback1 = vi.fn();

      await sut.listen(callback1);
      sut.close();

      // When: listen called again
      const callback2 = vi.fn();

      await sut.listen(callback2);

      // Then: second listen succeeds
      expect(callback2).toHaveBeenCalled();
      expect(patternRegistry.registerHandlers).toHaveBeenCalledTimes(2);
    });
  });

  describe('unwrap()', () => {
    it('should return connection when established', () => {
      // Given: connection exists
      const mockNc = createMock<NatsConnection>();

      Object.defineProperty(connection, 'unwrap', { get: () => mockNc, configurable: true });

      // When/Then
      expect(sut.unwrap()).toBe(mockNc);
    });

    it('should throw when connection is not established', () => {
      // Given: no connection
      Object.defineProperty(connection, 'unwrap', { get: () => null, configurable: true });

      // When/Then
      expect(() => sut.unwrap()).toThrow('Not connected');
    });
  });

  describe('on()', () => {
    it('should store callback for event', () => {
      // Given: register a callback
      const callback = vi.fn();

      // When
      sut.on('test-event', callback);

      // Then: no error (callback stored internally)
      expect(() => {
        sut.on('test-event', vi.fn());
      }).not.toThrow();
    });
  });
});
