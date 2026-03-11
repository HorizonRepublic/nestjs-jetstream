import { createMock } from '@golevelup/ts-jest';
import { faker } from '@faker-js/faker';

import { ConnectionProvider } from '../connection';
import { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';
import { JetstreamStrategy } from '../server/strategy';

import { ShutdownManager } from './shutdown.manager';

describe(ShutdownManager, () => {
  let sut: ShutdownManager;

  let connection: jest.Mocked<ConnectionProvider>;
  let eventBus: jest.Mocked<EventBus>;
  let timeout: number;

  beforeEach(() => {
    connection = createMock<ConnectionProvider>({
      shutdown: jest.fn().mockResolvedValue(undefined),
    });
    eventBus = createMock<EventBus>();
    timeout = faker.number.int({ min: 1000, max: 30000 });
    sut = new ShutdownManager(connection, eventBus, timeout);
  });

  afterEach(jest.resetAllMocks);

  describe('shutdown()', () => {
    describe('happy path', () => {
      describe('when strategy is provided', () => {
        it('should close strategy and drain connection', async () => {
          // Given: a strategy
          const strategy = createMock<JetstreamStrategy>();

          // When: shutdown
          await sut.shutdown(strategy);

          // Then: strategy closed, connection drained
          expect(strategy.close).toHaveBeenCalled();
          expect(connection.shutdown).toHaveBeenCalled();
        });

        it('should emit ShutdownStart and ShutdownComplete events', async () => {
          // Given: a strategy
          const strategy = createMock<JetstreamStrategy>();

          // When: shutdown
          await sut.shutdown(strategy);

          // Then: lifecycle events emitted in order
          expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownStart);
          expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownComplete);
        });
      });

      describe('when no strategy is provided', () => {
        it('should still drain connection and emit events', async () => {
          // When: shutdown without strategy
          await sut.shutdown();

          // Then: connection drained, events emitted
          expect(connection.shutdown).toHaveBeenCalled();
          expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownStart);
          expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownComplete);
        });
      });
    });

    describe('edge cases', () => {
      describe('when connection.shutdown() hangs past timeout', () => {
        it('should resolve after timeout via Promise.race', async () => {
          jest.useFakeTimers();

          // Given: connection.shutdown never resolves
          connection.shutdown.mockReturnValue(new Promise(() => {}));
          sut = new ShutdownManager(connection, eventBus, 5000);

          // When: shutdown starts, then timeout fires
          const promise = sut.shutdown();

          jest.advanceTimersByTime(5000);
          await promise;

          // Then: resolved via timeout, events emitted
          expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ShutdownComplete);

          jest.useRealTimers();
        });
      });
    });
  });
});
