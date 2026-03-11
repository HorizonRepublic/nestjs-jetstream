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

  describe('default handlers (Logger fallback)', () => {
    describe('when no hook is provided for Connect', () => {
      it('should log the server address', () => {
        const server = faker.internet.url();

        sut.emit(TransportEvent.Connect, server);

        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(server));
      });
    });

    describe('when no hook is provided for Disconnect', () => {
      it('should warn about connection loss', () => {
        sut.emit(TransportEvent.Disconnect);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
      });
    });

    describe('when no hook is provided for Reconnect', () => {
      it('should log the reconnection', () => {
        const server = faker.internet.url();

        sut.emit(TransportEvent.Reconnect, server);

        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Reconnected'));
      });
    });

    describe('when no hook is provided for Error', () => {
      it('should log the error', () => {
        sut.emit(TransportEvent.Error, new Error('test'));

        expect(logger.error).toHaveBeenCalled();
      });
    });

    describe('when no hook is provided for RpcTimeout', () => {
      it('should warn with subject and correlation id', () => {
        const subject = faker.lorem.word();
        const cid = faker.string.uuid();

        sut.emit(TransportEvent.RpcTimeout, subject, cid);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(subject));
      });
    });

    describe('when no hook is provided for MessageRouted', () => {
      it('should debug log the subject', () => {
        const subject = faker.lorem.word();

        sut.emit(TransportEvent.MessageRouted, subject, 'event');

        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining(subject));
      });
    });

    describe('when no hook is provided for ShutdownStart', () => {
      it('should log shutdown initiation', () => {
        sut.emit(TransportEvent.ShutdownStart);

        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
      });
    });

    describe('when no hook is provided for ShutdownComplete', () => {
      it('should log shutdown completion', () => {
        sut.emit(TransportEvent.ShutdownComplete);

        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
      });
    });

    describe('when no hook is provided for DeadLetter', () => {
      it('should warn with the message subject', () => {
        // Given: dead letter info with a subject
        const subject = faker.lorem.word();

        // When: DeadLetter event emitted
        sut.emit(TransportEvent.DeadLetter, { subject } as Parameters<
          import('../interfaces').TransportHooks[typeof TransportEvent.DeadLetter]
        >[0]);

        // Then: subject appears in the warning
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(subject));
      });

      it('should warn with "unknown" when subject is missing', () => {
        // Given: dead letter info without a subject
        // When: DeadLetter event emitted with info lacking subject
        sut.emit(
          TransportEvent.DeadLetter,
          {} as Parameters<
            import('../interfaces').TransportHooks[typeof TransportEvent.DeadLetter]
          >[0],
        );

        // Then: "unknown" appears in the warning
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown'));
      });
    });
  });

  describe('edge cases', () => {
    describe('when partial hooks are provided', () => {
      it('should use hook for overridden events and logger for the rest', () => {
        // Given: only Connect is overridden
        const onConnect = vi.fn();

        sut = new EventBus(logger, { [TransportEvent.Connect]: onConnect });

        // When: both Connect and Disconnect emitted
        sut.emit(TransportEvent.Connect, 'server');
        sut.emit(TransportEvent.Disconnect);

        // Then: Connect goes to hook, Disconnect to logger
        expect(onConnect).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
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
