import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import type { MessageHandler } from '@nestjs/microservices';
import type { NatsConnection } from '@nats-io/transport-node';

import { ConnectionProvider } from '../../connection';
import type { JetstreamModuleOptions } from '../../interfaces';

import { CoreRpcServer } from '../core-rpc.server';
import {
  ConsumerProvider,
  MessageProvider,
  MetadataProvider,
  StreamProvider,
} from '../infrastructure';
import { EventRouter, PatternRegistry, RpcRouter } from '../routing';
import { JetstreamStrategy } from '../strategy';

const fakeHandler = (): MessageHandler => vi.fn() as unknown as MessageHandler;

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
  let metadataProvider: Mocked<MetadataProvider>;
  let options: JetstreamModuleOptions;

  beforeEach(() => {
    options = { name: 'test', servers: ['nats://localhost:4222'] };
    connection = createMock<ConnectionProvider>();
    patternRegistry = createMock<PatternRegistry>({
      hasEventHandlers: vi.fn().mockReturnValue(false),
      hasBroadcastHandlers: vi.fn().mockReturnValue(false),
      hasRpcHandlers: vi.fn().mockReturnValue(false),
      hasMetadata: vi.fn().mockReturnValue(false),
    });
    streamProvider = createMock<StreamProvider>();
    consumerProvider = createMock<ConsumerProvider>({
      ensureConsumers: vi.fn().mockResolvedValue(new Map()),
    });
    messageProvider = createMock<MessageProvider>();
    eventRouter = createMock<EventRouter>();
    rpcRouter = createMock<RpcRouter>();
    coreRpcServer = createMock<CoreRpcServer>();
    metadataProvider = createMock<MetadataProvider>();

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
      new Map(),
      metadataProvider,
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

    it('should forward doListen errors to callback and resolve (not rethrow)', async () => {
      // Given: event handlers present so ensureStreams is reached; it rejects
      const sentinelError = new Error('stream provisioning failed');

      patternRegistry.hasEventHandlers = vi.fn().mockReturnValue(true);
      streamProvider.ensureStreams = vi.fn().mockRejectedValue(sentinelError);
      const callback = vi.fn();

      // When
      await sut.listen(callback);

      // Then: error forwarded to callback; listen() itself resolved
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(sentinelError);
    });
  });

  describe('startup ordering', () => {
    it('should subscribe routers before starting consumption', async () => {
      // Given: event handlers exist, so a durable consumer will be started
      patternRegistry.hasEventHandlers.mockReturnValue(true);

      // When: transport starts
      await sut.listen(vi.fn());

      // Then: the router observes the message subjects before the consumer begins
      // delivering; consumers flush pending backlog immediately, and a Subject with
      // no observers drops messages silently
      expect(eventRouter.start).toHaveBeenCalled();
      expect(messageProvider.start).toHaveBeenCalled();
      expect(eventRouter.start.mock.invocationCallOrder[0]!).toBeLessThan(
        messageProvider.start.mock.invocationCallOrder[0]!,
      );
    });
  });

  describe('metadata publishing', () => {
    it('should publish metadata when handlers have meta', async () => {
      // Given: pattern registry has metadata
      const metadataEntries = new Map([['svc.ev.order.created', { http: { method: 'POST' } }]]);

      patternRegistry.hasMetadata = vi.fn().mockReturnValue(true);
      patternRegistry.getMetadataEntries = vi.fn().mockReturnValue(metadataEntries);

      // When
      await sut.listen(vi.fn());

      // Then
      expect(metadataProvider.publish).toHaveBeenCalledWith(metadataEntries);
    });

    it('should not publish metadata when no handlers have meta', async () => {
      // Given: no metadata
      patternRegistry.hasMetadata = vi.fn().mockReturnValue(false);

      // When
      await sut.listen(vi.fn());

      // Then
      expect(metadataProvider.publish).not.toHaveBeenCalled();
    });
  });

  describe('addHandler()', () => {
    it('should register a handler when the pattern is unique', () => {
      // Given: a fresh strategy
      // When
      sut.addHandler('user.created', fakeHandler(), true);

      // Then: handler is stored, no throw
      expect(sut.getHandlers().size).toBe(1);
    });

    it('should throw when the same pattern is registered twice', () => {
      // Given: a handler already registered for the pattern
      sut.addHandler('user.created', fakeHandler(), true);

      // When/Then: the second registration fails fast
      expect(() => {
        sut.addHandler('user.created', fakeHandler(), true);
      }).toThrow(/Duplicate handler registered for pattern "user\.created"/);
    });

    it('should throw when an event handler collides with an RPC handler on the same pattern', () => {
      // Given: an event handler registered
      sut.addHandler('user.created', fakeHandler(), true);

      // When/Then: an RPC handler (isEventHandler=false) for the same pattern is rejected
      expect(() => {
        sut.addHandler('user.created', fakeHandler(), false);
      }).toThrow(/Duplicate handler registered/);
    });

    it('should mention the conflicting pattern in the error message', () => {
      // Given
      sut.addHandler('orders.placed', fakeHandler(), false);

      // When/Then
      expect(() => {
        sut.addHandler('orders.placed', fakeHandler(), false);
      }).toThrow(/orders\.placed/);
    });
  });

  describe('close()', () => {
    it('should destroy metadata provider on close', async () => {
      // Given: strategy has started
      await sut.listen(vi.fn());

      // When
      sut.close();

      // Then
      expect(metadataProvider.destroy).toHaveBeenCalled();
    });

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
