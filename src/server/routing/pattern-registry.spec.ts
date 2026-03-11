import type { MessageHandler } from '@nestjs/microservices';
import { faker } from '@faker-js/faker';

import type { JetstreamModuleOptions } from '../../interfaces';

import { PatternRegistry } from './pattern-registry';

const createHandler = (opts: { isEvent?: boolean; broadcast?: boolean } = {}): MessageHandler => {
  const handler = jest.fn() as MessageHandler;

  handler.isEventHandler = opts.isEvent ?? false;

  if (opts.broadcast) {
    handler.extras = { broadcast: true };
  }

  return handler;
};

describe(PatternRegistry, () => {
  let sut: PatternRegistry;

  let serviceName: string;

  beforeEach(() => {
    serviceName = faker.lorem.word();

    const options: JetstreamModuleOptions = {
      name: serviceName,
      servers: ['nats://localhost:4222'],
    };

    sut = new PatternRegistry(options);
  });

  afterEach(jest.resetAllMocks);

  describe('registerHandlers()', () => {
    describe('happy path', () => {
      describe('when registering an RPC handler', () => {
        it('should map to a cmd subject', () => {
          // Given: a handler for get.user
          const handler = createHandler();
          const handlers = new Map<string, MessageHandler>([['get.user', handler]]);

          // When: registered
          sut.registerHandlers(handlers);

          // Then: mapped to full cmd subject
          expect(sut.getHandler(`${serviceName}__microservice.cmd.get.user`)).toBe(handler);
        });
      });

      describe('when registering an event handler', () => {
        it('should map to an ev subject', () => {
          // Given: an event handler
          const handler = createHandler({ isEvent: true });
          const handlers = new Map<string, MessageHandler>([['user.created', handler]]);

          // When: registered
          sut.registerHandlers(handlers);

          // Then: mapped to full ev subject
          expect(sut.getHandler(`${serviceName}__microservice.ev.user.created`)).toBe(handler);
        });
      });

      describe('when registering a broadcast handler', () => {
        it('should map to a broadcast subject', () => {
          // Given: a broadcast handler
          const handler = createHandler({ isEvent: true, broadcast: true });
          const handlers = new Map<string, MessageHandler>([['config.updated', handler]]);

          // When: registered
          sut.registerHandlers(handlers);

          // Then: mapped to broadcast subject
          expect(sut.getHandler('broadcast.config.updated')).toBe(handler);
        });
      });
    });
  });

  describe('getHandler()', () => {
    describe('edge cases', () => {
      describe('when subject is not registered', () => {
        it('should return null', () => {
          expect(sut.getHandler('unknown.subject')).toBeNull();
        });
      });
    });
  });

  describe('pattern queries', () => {
    beforeEach(() => {
      const handlers = new Map<string, MessageHandler>([
        ['get.user', createHandler()],
        ['create.order', createHandler()],
        ['user.created', createHandler({ isEvent: true })],
        ['config.updated', createHandler({ isEvent: true, broadcast: true })],
      ]);

      sut.registerHandlers(handlers);
    });

    describe('hasRpcHandlers()', () => {
      it('should return true when RPC handlers are registered', () => {
        expect(sut.hasRpcHandlers()).toBe(true);
      });
    });

    describe('hasEventHandlers()', () => {
      it('should return true when workqueue event handlers are registered', () => {
        expect(sut.hasEventHandlers()).toBe(true);
      });
    });

    describe('hasBroadcastHandlers()', () => {
      it('should return true when broadcast handlers are registered', () => {
        expect(sut.hasBroadcastHandlers()).toBe(true);
      });
    });

    describe('getPatternsByKind()', () => {
      it('should categorize patterns into commands, events, and broadcasts', () => {
        // When: patterns queried
        const kinds = sut.getPatternsByKind();

        // Then: correctly categorized
        expect(kinds.commands).toEqual(expect.arrayContaining(['get.user', 'create.order']));
        expect(kinds.events).toEqual(['user.created']);
        expect(kinds.broadcasts).toEqual(['config.updated']);
      });
    });

    describe('getBroadcastPatterns()', () => {
      it('should return broadcast subjects with prefix', () => {
        expect(sut.getBroadcastPatterns()).toEqual(['broadcast.config.updated']);
      });
    });
  });

  describe('normalizeSubject()', () => {
    it.each([
      ['cmd', `CMD_PLACEHOLDER.cmd.get.user`, 'get.user'],
      ['ev', `CMD_PLACEHOLDER.ev.user.created`, 'user.created'],
      ['broadcast', 'broadcast.config.updated', 'config.updated'],
    ])('should strip %s prefix', (_kind, subject, expected) => {
      const resolvedSubject = subject.replace('CMD_PLACEHOLDER', `${serviceName}__microservice`);

      expect(sut.normalizeSubject(resolvedSubject)).toBe(expected);
    });

    describe('when no prefix matches', () => {
      it('should return the subject as-is', () => {
        const subject = faker.lorem.word();

        expect(sut.normalizeSubject(subject)).toBe(subject);
      });
    });
  });

  describe('edge cases', () => {
    describe('when no handlers are registered', () => {
      it('should report no handlers of any type', () => {
        // Given: empty registration
        sut.registerHandlers(new Map());

        // Then: all queries return false/empty
        expect(sut.hasRpcHandlers()).toBe(false);
        expect(sut.hasEventHandlers()).toBe(false);
        expect(sut.hasBroadcastHandlers()).toBe(false);
        expect(sut.getPatternsByKind()).toEqual({ commands: [], events: [], broadcasts: [] });
      });
    });
  });
});
