import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { Msg, NatsConnection, Subscription } from '@nats-io/transport-node';

import { ConnectionProvider } from '../../connection';
import { EventBus } from '../../hooks';
import type { Codec, JetstreamModuleOptions } from '../../interfaces';

import { CoreRpcServer } from '../core-rpc.server';
import { PatternRegistry } from '../routing/pattern-registry';

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
          expect(eventBus.emitMessageRouted).toHaveBeenCalledWith(msg.subject, 'rpc');
        });
      });
    });

    describe('edge cases', () => {
      describe('when no handler is found', () => {
        it('should respond with error instead of silently dropping', async () => {
          // Given: no handler registered
          patternRegistry.getHandler.mockReturnValue(null);

          const msg = createMock<Msg>({
            subject: 'unknown.cmd.test',
            data: codec.encode({}),
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

      describe('when handleRequest throws unhandled error', () => {
        it('should catch via .catch() callback without crashing', async () => {
          // Given: patternRegistry.getHandler throws synchronously
          patternRegistry.getHandler.mockImplementation(() => {
            throw new Error('registry exploded');
          });

          const msg = createMock<Msg>({
            subject: `${serviceName}__microservice.cmd.test`,
            reply: 'reply.subject',
            data: codec.encode({}),
          });

          // When: message arrives — handleRequest throws, caught by .catch()
          subscriptionCallback(null, msg);
          await new Promise(process.nextTick);

          // Then: no crash — the outer .catch() handles it silently
          expect(msg.respond).not.toHaveBeenCalled();
        });
      });

      describe('when codec.encode fails in error response', () => {
        it('should not crash when respondWithError fails internally', async () => {
          // Given: handler throws, AND codec.encode also throws when encoding the error
          const handler = vi.fn().mockRejectedValue(new Error('handler failed'));

          patternRegistry.getHandler.mockReturnValue(handler);
          codec.decode.mockReturnValue({});

          const msg = createMock<Msg>({
            subject: `${serviceName}__microservice.cmd.test`,
            reply: 'reply.subject',
            data: new TextEncoder().encode('{}'),
          });

          // Make encode throw when encoding the error response
          codec.encode.mockImplementation(() => {
            throw new Error('encode failed');
          });

          // When: message arrives
          subscriptionCallback(null, msg);
          await new Promise(process.nextTick);

          // Then: no crash, msg.respond NOT called (encode failed in respondWithError)
          expect(msg.respond).not.toHaveBeenCalled();
        });
      });

      describe('when message has no reply subject (fire-and-forget)', () => {
        it('should ignore the message and not invoke handler', async () => {
          // Given: handler registered
          const handler = vi.fn();

          patternRegistry.getHandler.mockReturnValue(handler);

          const msg = createMock<Msg>({
            subject: `${serviceName}__microservice.cmd.test`,
            reply: '', // empty reply = fire-and-forget
            data: codec.encode({}),
          });

          // When: message arrives
          subscriptionCallback(null, msg);
          await new Promise(process.nextTick);

          // Then: handler not invoked, no response sent
          expect(handler).not.toHaveBeenCalled();
          expect(msg.respond).not.toHaveBeenCalled();
        });
      });
    });
  });
});
