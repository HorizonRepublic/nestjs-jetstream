import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { Logger } from '@nestjs/common';
import { faker } from '@faker-js/faker';

import { TransportEvent } from '../interfaces';

import { EventBus } from './event-bus';

describe(EventBus, () => {
  let sut: EventBus;

  let logger: Mocked<Logger>;

  beforeEach(() => {
    logger = createMock<Logger>();
    sut = new EventBus(logger);
  });

  afterEach(vi.resetAllMocks);

  describe('happy path', () => {
    describe('when custom hook is provided', () => {
      it('should dispatch to the hook instead of logger', () => {
        // Given: a custom Connect hook
        const onConnect = vi.fn();

        sut = new EventBus(logger, { [TransportEvent.Connect]: onConnect });
        const server = faker.internet.url();

        // When: event emitted
        sut.emit(TransportEvent.Connect, server);

        // Then: custom hook called, logger NOT called
        expect(onConnect).toHaveBeenCalledWith(server);
        expect(logger.log).not.toHaveBeenCalled();
      });

      it('should pass all arguments to the hook', () => {
        // Given: an Error hook
        const onError = vi.fn();

        sut = new EventBus(logger, { [TransportEvent.Error]: onError });
        const error = new Error(faker.lorem.sentence());
        const context = faker.lorem.word();

        // When: emitted with multiple args
        sut.emit(TransportEvent.Error, error, context);

        // Then: all args forwarded
        expect(onError).toHaveBeenCalledWith(error, context);
      });
    });
  });

  describe('no-op when hook is not registered', () => {
    it('should not log anything when no hook is provided', () => {
      // Given: no hooks registered
      // When: events emitted
      sut.emit(TransportEvent.Connect, faker.internet.url());
      sut.emit(TransportEvent.Disconnect);
      sut.emit(TransportEvent.Error, new Error('test'));

      // Then: logger is never called
      expect(logger.log).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    describe('when partial hooks are provided', () => {
      it('should dispatch to hook for registered events and no-op for the rest', () => {
        // Given: only Connect is overridden
        const onConnect = vi.fn();

        sut = new EventBus(logger, { [TransportEvent.Connect]: onConnect });

        // When: both Connect and Disconnect emitted
        sut.emit(TransportEvent.Connect, 'server');
        sut.emit(TransportEvent.Disconnect);

        // Then: Connect goes to hook, Disconnect is silently ignored
        expect(onConnect).toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('error paths', () => {
    describe('when custom hook throws', () => {
      it('should catch the error and log it without rethrowing', () => {
        // Given: a hook that throws
        const message = faker.lorem.sentence();
        const throwingHook = vi.fn(() => {
          throw new Error(message);
        });

        sut = new EventBus(logger, { [TransportEvent.Connect]: throwingHook });

        // When: event emitted
        // Then: no throw, error logged
        expect(() => {
          sut.emit(TransportEvent.Connect, 'server');
        }).not.toThrow();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(message));
      });

      it('should catch async hook rejections and log them', async () => {
        // Given: an async hook that rejects
        const message = faker.lorem.sentence();
        const asyncHook = vi.fn().mockRejectedValue(new Error(message));

        sut = new EventBus(logger, { [TransportEvent.Connect]: asyncHook });

        // When: event emitted
        sut.emit(TransportEvent.Connect, 'server');
        await new Promise(process.nextTick);

        // Then: rejection caught and logged
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(message));
      });

      it('should catch async hook rejections with non-Error values', async () => {
        // Given: an async hook that rejects with a plain string
        const thrown = faker.lorem.word();
        const asyncHook = vi.fn().mockRejectedValue(thrown);

        sut = new EventBus(logger, { [TransportEvent.Connect]: asyncHook });

        // When: event emitted
        sut.emit(TransportEvent.Connect, 'server');
        await new Promise(process.nextTick);

        // Then: raw value appears in log
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(thrown));
      });

      it('should stringify non-Error thrown values in the log message', () => {
        // Given: a hook that throws a plain string (not an Error)
        const thrown = faker.lorem.word();
        const throwingHook = vi.fn(() => {
          throw thrown;
        });

        sut = new EventBus(logger, { [TransportEvent.Connect]: throwingHook });

        // When: event emitted
        sut.emit(TransportEvent.Connect, 'server');

        // Then: the raw thrown value appears in the log
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(thrown));
      });
    });
  });
});
