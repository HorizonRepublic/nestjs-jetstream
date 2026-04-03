import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageHandler } from '@nestjs/microservices';
import { faker } from '@faker-js/faker';

import { StreamKind } from '../../../interfaces';
import type { JetstreamModuleOptions } from '../../../interfaces';
import { metadataKey } from '../../../jetstream.constants';

import { PatternRegistry } from '../pattern-registry';

const createHandler = (
  opts: {
    isEvent?: boolean;
    broadcast?: boolean;
    ordered?: boolean;
    meta?: Record<string, unknown>;
  } = {},
): MessageHandler => {
  const handler = vi.fn() as MessageHandler;

  handler.isEventHandler = opts.isEvent ?? opts.ordered ?? false;

  const extras: Record<string, unknown> = {};

  if (opts.broadcast) extras.broadcast = true;
  if (opts.ordered) extras.ordered = true;
  if (opts.meta) extras.meta = opts.meta;

  if (Object.keys(extras).length > 0) {
    handler.extras = extras;
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

  afterEach(vi.resetAllMocks);

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

      describe('when registering an ordered handler', () => {
        it('should map to an ev subject with isOrdered flag', () => {
          // Given: an ordered event handler
          const handler = createHandler({ ordered: true });
          const handlers = new Map<string, MessageHandler>([['order.status', handler]]);

          // When: registered
          sut.registerHandlers(handlers);

          // Then: mapped to ev subject (shared stream), retrievable
          expect(sut.getHandler(`${serviceName}__microservice.ordered.order.status`)).toBe(handler);
        });

        it('should not count as a workqueue event handler', () => {
          // Given: only ordered handler
          const handler = createHandler({ ordered: true });
          const handlers = new Map<string, MessageHandler>([['order.status', handler]]);

          // When: registered
          sut.registerHandlers(handlers);

          // Then: ordered yes, workqueue no
          expect(sut.hasOrderedHandlers()).toBe(true);
          expect(sut.hasEventHandlers()).toBe(false);
        });

        it('should appear in getOrderedSubjects()', () => {
          // Given: ordered handler
          const handler = createHandler({ ordered: true });
          const handlers = new Map<string, MessageHandler>([['order.status', handler]]);

          // When: registered
          sut.registerHandlers(handlers);

          // Then: full NATS subject returned
          expect(sut.getOrderedSubjects()).toEqual([
            `${serviceName}__microservice.ordered.order.status`,
          ]);
        });

        it('should categorize as ordered in getPatternsByKind()', () => {
          // Given: ordered handler
          const handler = createHandler({ ordered: true });
          const handlers = new Map<string, MessageHandler>([['order.status', handler]]);

          // When: registered
          sut.registerHandlers(handlers);

          // Then: in ordered, not in events
          const kinds = sut.getPatternsByKind();

          expect(kinds.ordered).toEqual(['order.status']);
          expect(kinds.events).toEqual([]);
        });

        it('should not count as RPC handler', () => {
          // Given: only ordered handler
          const handler = createHandler({ ordered: true });
          const handlers = new Map<string, MessageHandler>([['order.status', handler]]);

          // When: registered
          sut.registerHandlers(handlers);

          // Then: not RPC
          expect(sut.hasRpcHandlers()).toBe(false);
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
      ['ordered', `CMD_PLACEHOLDER.ordered.order.status`, 'order.status'],
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

  describe('error paths', () => {
    describe('when handler has both broadcast and ordered', () => {
      it('should throw a descriptive error', () => {
        // Given: a handler with conflicting flags
        const handler = vi.fn() as MessageHandler;

        handler.isEventHandler = true;
        handler.extras = { broadcast: true, ordered: true };

        const handlers = new Map<string, MessageHandler>([['conflict', handler]]);

        // When/Then: throws
        expect(() => {
          sut.registerHandlers(handlers);
        }).toThrow(/cannot be both broadcast and ordered/i);
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
        expect(sut.getPatternsByKind()).toEqual({
          commands: [],
          events: [],
          broadcasts: [],
          ordered: [],
        });
      });
    });
  });

  describe('metadata', () => {
    describe('hasMetadata()', () => {
      it('should return true when at least one handler has meta', () => {
        // Given: one handler with meta, one without
        const handlers = new Map<string, MessageHandler>([
          [
            'order.created',
            createHandler({
              isEvent: true,
              meta: { http: { method: 'POST', path: '/orders' } },
            }),
          ],
          ['internal.cleanup', createHandler({ isEvent: true })],
        ]);

        // When: registered
        sut.registerHandlers(handlers);

        // Then
        expect(sut.hasMetadata()).toBe(true);
      });

      it('should return false when no handler has meta', () => {
        // Given: handlers without meta
        const handlers = new Map<string, MessageHandler>([
          ['order.created', createHandler({ isEvent: true })],
          ['get.user', createHandler()],
        ]);

        // When: registered
        sut.registerHandlers(handlers);

        // Then
        expect(sut.hasMetadata()).toBe(false);
      });

      it('should return false when no handlers are registered', () => {
        // Given: empty registration
        sut.registerHandlers(new Map());

        // Then
        expect(sut.hasMetadata()).toBe(false);
      });
    });

    describe('getMetadataEntries()', () => {
      it('should return metadata keyed by service.kind.pattern for event handlers', () => {
        // Given: event handler with meta
        const meta = { http: { method: 'POST', path: '/orders' } };
        const handlers = new Map<string, MessageHandler>([
          ['order.created', createHandler({ isEvent: true, meta })],
        ]);

        // When
        sut.registerHandlers(handlers);
        const entries = sut.getMetadataEntries();

        // Then
        const expectedKey = metadataKey(serviceName, StreamKind.Event, 'order.created');

        expect(entries.get(expectedKey)).toEqual(meta);
      });

      it('should return metadata keyed by service.kind.pattern for command handlers', () => {
        // Given: RPC handler with meta
        const meta = { http: { method: 'GET', path: '/orders/:id' } };
        const handlers = new Map<string, MessageHandler>([['order.get', createHandler({ meta })]]);

        // When
        sut.registerHandlers(handlers);
        const entries = sut.getMetadataEntries();

        // Then
        const expectedKey = metadataKey(serviceName, StreamKind.Command, 'order.get');

        expect(entries.get(expectedKey)).toEqual(meta);
      });

      it('should return metadata keyed by service.kind.pattern for broadcast handlers', () => {
        // Given: broadcast handler with meta
        const meta = { scope: 'global' };
        const handlers = new Map<string, MessageHandler>([
          ['config.updated', createHandler({ isEvent: true, broadcast: true, meta })],
        ]);

        // When
        sut.registerHandlers(handlers);
        const entries = sut.getMetadataEntries();

        // Then
        const expectedKey = metadataKey(serviceName, StreamKind.Broadcast, 'config.updated');

        expect(entries.get(expectedKey)).toEqual(meta);
      });

      it('should return metadata keyed by service.kind.pattern for ordered handlers', () => {
        // Given: ordered handler with meta
        const meta = { tracking: true };
        const handlers = new Map<string, MessageHandler>([
          ['audit.trail', createHandler({ ordered: true, meta })],
        ]);

        // When
        sut.registerHandlers(handlers);
        const entries = sut.getMetadataEntries();

        // Then
        const expectedKey = metadataKey(serviceName, StreamKind.Ordered, 'audit.trail');

        expect(entries.get(expectedKey)).toEqual(meta);
      });

      it('should exclude handlers without meta', () => {
        // Given: mix of handlers with and without meta
        const handlers = new Map<string, MessageHandler>([
          [
            'order.created',
            createHandler({
              isEvent: true,
              meta: { http: { method: 'POST', path: '/orders' } },
            }),
          ],
          ['internal.cleanup', createHandler({ isEvent: true })],
        ]);

        // When
        sut.registerHandlers(handlers);
        const entries = sut.getMetadataEntries();

        // Then
        expect(entries.size).toBe(1);
      });

      it('should return empty map when no handlers have meta', () => {
        // Given: handlers without meta
        const handlers = new Map<string, MessageHandler>([
          ['order.created', createHandler({ isEvent: true })],
        ]);

        // When
        sut.registerHandlers(handlers);

        // Then
        expect(sut.getMetadataEntries().size).toBe(0);
      });
    });
  });
});
