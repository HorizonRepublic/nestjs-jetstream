import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { Msg, NatsConnection, Subscription } from 'nats';

import { ConnectionProvider } from '../connection';
import { EventBus } from '../hooks';
import type { Codec, JetstreamModuleOptions } from '../interfaces';
import { TransportEvent } from '../interfaces';

import { CoreRpcServer } from './core-rpc.server';
import { PatternRegistry } from './routing/pattern-registry';

describe(CoreRpcServer, () => {
  let sut: CoreRpcServer;

  let connection: Mocked<ConnectionProvider>;
  let patternRegistry: Mocked<PatternRegistry>;
  let codec: Mocked<Codec>;
  let eventBus: Mocked<EventBus>;

  let serviceName: string;
  let mockNc: Mocked<NatsConnection>;

  beforeEach(() => {
    serviceName = faker.lorem.word();

    const options: JetstreamModuleOptions = {
      name: serviceName,
      servers: ['nats://localhost:4222'],
    };

    connection = createMock<ConnectionProvider>();
    patternRegistry = createMock<PatternRegistry>();
    codec = createMock<Codec>({
      decode: vi.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
      encode: vi.fn((data: unknown) => new TextEncoder().encode(JSON.stringify(data))),
    });
    eventBus = createMock<EventBus>();

    mockNc = createMock<NatsConnection>();
    connection.getConnection.mockResolvedValue(mockNc);

    sut = new CoreRpcServer(options, connection, patternRegistry, codec, eventBus);
  });

  afterEach(vi.resetAllMocks);

  describe('start()', () => {
    describe('happy path', () => {
      describe('when started', () => {
        it('should subscribe to the cmd subject with queue group', async () => {
          // When: started
          await sut.start();

          // Then: subscription created with correct subject and queue
          expect(mockNc.subscribe).toHaveBeenCalledWith(
            `${serviceName}__microservice.cmd.>`,
            expect.objectContaining({
              queue: `${serviceName}__microservice_cmd_queue`,
              callback: expect.any(Function),
            }),
          );
        });
      });
    });
  });

  describe('stop()', () => {
    describe('happy path', () => {
      describe('when stopped after start', () => {
        it('should unsubscribe', async () => {
          // Given: started
          const mockSub = createMock<Subscription>();

          mockNc.subscribe.mockReturnValue(mockSub);
          await sut.start();

          // When: stopped
          sut.stop();

          // Then: subscription unsubscribed
          expect(mockSub.unsubscribe).toHaveBeenCalled();
        });
      });
    });

    describe('edge cases', () => {
      describe('when stopped without start', () => {
        it('should not throw', () => {
          expect(() => {
            sut.stop();
          }).not.toThrow();
        });
      });
    });
  });

  describe('request handling', () => {
    let subscriptionCallback: (err: Error | null, msg: Msg) => void;

    beforeEach(async () => {
      const mockSub = createMock<Subscription>();

      mockNc.subscribe.mockReturnValue(mockSub);
      await sut.start();

      subscriptionCallback = mockNc.subscribe.mock.calls[0]![1]!.callback! as (
        err: Error | null,
        msg: Msg,
      ) => void;
    });

    describe('happy path', () => {
      describe('when handler returns a result', () => {
        it('should respond with encoded result', async () => {
          // Given: a handler that returns data
          const responseData = { id: faker.number.int() };
          const handler = vi.fn().mockResolvedValue(responseData);

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createMock<Msg>({
            subject: `${serviceName}__microservice.cmd.get.user`,
            data: codec.encode({ userId: 1 }),
          });

          // When: message arrives
          subscriptionCallback(null, msg);
          await new Promise(process.nextTick);

          // Then: response sent, event emitted
          expect(msg.respond).toHaveBeenCalledWith(codec.encode(responseData));
          expect(eventBus.emit).toHaveBeenCalledWith(
            TransportEvent.MessageRouted,
            msg.subject,
            'rpc',
          );
        });
      });
    });

    describe('edge cases', () => {
      describe('when no handler is found', () => {
        it('should not respond', async () => {
          // Given: no handler registered
          patternRegistry.getHandler.mockReturnValue(null);

          const msg = createMock<Msg>({
            subject: 'unknown.cmd.test',
            data: codec.encode({}),
          });

          // When: message arrives
          subscriptionCallback(null, msg);
          await new Promise(process.nextTick);

          // Then: no response sent
          expect(msg.respond).not.toHaveBeenCalled();
        });
      });

      describe('when subscription error occurs', () => {
        it('should not process the message', () => {
          // Given: a subscription error
          const msg = createMock<Msg>();

          // When: error callback
          subscriptionCallback(new Error('sub error'), msg);

          // Then: handler not invoked
          expect(patternRegistry.getHandler).not.toHaveBeenCalled();
        });
      });
    });

    describe('error paths', () => {
      describe('when codec.decode() throws', () => {
        it('should respond with error and x-error header', async () => {
          // Given: decode will throw
          const handler = vi.fn();

          patternRegistry.getHandler.mockReturnValue(handler);
          codec.decode.mockImplementation(() => {
            throw new Error('bad json');
          });

          const msg = createMock<Msg>({
            subject: `${serviceName}__microservice.cmd.test`,
            data: new Uint8Array([0xff]),
          });

          // When: message arrives
          subscriptionCallback(null, msg);
          await new Promise(process.nextTick);

          // Then: error response sent, handler NOT called
          expect(handler).not.toHaveBeenCalled();
          expect(msg.respond).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            expect.objectContaining({
              headers: expect.anything(),
            }),
          );
        });
      });

      describe('when handler throws', () => {
        it('should respond with error and x-error header', async () => {
          // Given: handler that throws
          const handler = vi.fn().mockRejectedValue(new Error('handler failed'));

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createMock<Msg>({
            subject: `${serviceName}__microservice.cmd.test`,
            data: codec.encode({ test: true }),
          });

          // When: message arrives
          subscriptionCallback(null, msg);
          await new Promise(process.nextTick);

          // Then: error response sent with x-error header
          expect(msg.respond).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            expect.objectContaining({
              headers: expect.anything(),
            }),
          );
        });
      });
    });
  });
});
