import { beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { ConsumerInfo } from 'nats';
import { NatsError } from 'nats';

import { ConnectionProvider } from '../../connection';
import type { JetstreamModuleOptions } from '../../interfaces';
import { PatternRegistry } from '../routing';

import { ConsumerProvider } from './consumer.provider';
import { StreamProvider } from './stream.provider';

describe(ConsumerProvider, () => {
  let sut: ConsumerProvider;

  let options: JetstreamModuleOptions;
  let connection: Mocked<ConnectionProvider>;
  let streamProvider: Mocked<StreamProvider>;
  let patternRegistry: Mocked<PatternRegistry>;
  let mockJsm: {
    consumers: {
      info: ReturnType<typeof vi.fn>;
      add: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    options = { name: faker.lorem.word(), servers: ['nats://localhost:4222'] };

    mockJsm = {
      consumers: {
        info: vi.fn(),
        add: vi.fn(),
        update: vi.fn(),
      },
    };

    connection = createMock<ConnectionProvider>({
      getJetStreamManager: vi.fn().mockResolvedValue(mockJsm),
    });
    streamProvider = createMock<StreamProvider>({
      getStreamName: vi.fn().mockReturnValue('test-stream'),
    });
    patternRegistry = createMock<PatternRegistry>();

    sut = new ConsumerProvider(options, connection, streamProvider, patternRegistry);
  });

  describe('ensureConsumer', () => {
    describe('when consumer info throws a non-CONSUMER_NOT_FOUND error', () => {
      it('should rethrow the error', async () => {
        // Given: jsm.consumers.info throws auth error
        const authError = new Error('authorization violation') as NatsError;

        authError.api_error = {
          err_code: 10100,
          code: 403,
          description: 'authorization violation',
        };
        mockJsm.consumers.info.mockRejectedValue(authError);

        // When/Then: propagates the error
        await expect(sut.ensureConsumers(['ev'])).rejects.toThrow('authorization violation');
        expect(mockJsm.consumers.add).not.toHaveBeenCalled();
      });
    });
  });

  describe('buildConfig', () => {
    describe('when broadcast has multiple patterns', () => {
      it('should use filter_subjects instead of filter_subject', async () => {
        // Given: registry returns 2 broadcast patterns
        const patterns = ['broadcast.config.updated', 'broadcast.user.synced'];

        patternRegistry.getBroadcastPatterns.mockReturnValue(patterns);

        mockJsm.consumers.info.mockResolvedValue(createMock<ConsumerInfo>());

        const updated = createMock<ConsumerInfo>();

        mockJsm.consumers.update.mockResolvedValue(updated);

        // When: ensure broadcast consumer
        await sut.ensureConsumers(['broadcast']);

        // Then: consumer updated with filter_subjects
        expect(mockJsm.consumers.update).toHaveBeenCalledWith(
          'test-stream',
          expect.any(String),
          expect.objectContaining({ filter_subjects: patterns }),
        );
      });
    });

    describe('when broadcast has single pattern', () => {
      it('should use filter_subject', async () => {
        // Given: registry returns 1 broadcast pattern
        patternRegistry.getBroadcastPatterns.mockReturnValue(['broadcast.config.updated']);

        mockJsm.consumers.info.mockResolvedValue(createMock<ConsumerInfo>());

        const updated = createMock<ConsumerInfo>();

        mockJsm.consumers.update.mockResolvedValue(updated);

        // When: ensure broadcast consumer
        await sut.ensureConsumers(['broadcast']);

        // Then: consumer updated with filter_subject
        expect(mockJsm.consumers.update).toHaveBeenCalledWith(
          'test-stream',
          expect.any(String),
          expect.objectContaining({ filter_subject: 'broadcast.config.updated' }),
        );
      });
    });

    describe('when consumer does not exist', () => {
      it('should create it with correct config for multiple broadcast patterns', async () => {
        // Given: consumer not found, registry has multiple patterns
        const notFoundError = new NatsError('consumer not found', 'UNKNOWN_ERROR');

        notFoundError.api_error = { err_code: 10014, code: 404, description: 'consumer not found' };
        mockJsm.consumers.info.mockRejectedValue(notFoundError);

        const patterns = ['broadcast.a', 'broadcast.b'];

        patternRegistry.getBroadcastPatterns.mockReturnValue(patterns);

        const created = createMock<ConsumerInfo>();

        mockJsm.consumers.add.mockResolvedValue(created);

        // When: ensure broadcast consumer
        await sut.ensureConsumers(['broadcast']);

        // Then: created with filter_subjects
        expect(mockJsm.consumers.add).toHaveBeenCalledWith(
          'test-stream',
          expect.objectContaining({ filter_subjects: patterns }),
        );
      });
    });

    describe('when ordered kind is passed', () => {
      it('should throw because ordered consumers are ephemeral', async () => {
        // Given: ordered kind (should never be used with durable consumer path)
        const notFoundError = new NatsError('consumer not found', 'UNKNOWN_ERROR');

        notFoundError.api_error = { err_code: 10014, code: 404, description: 'consumer not found' };
        mockJsm.consumers.info.mockRejectedValue(notFoundError);

        // When/Then: throws descriptive error
        await expect(sut.ensureConsumers(['ordered'])).rejects.toThrow(/ephemeral/i);
      });
    });
  });
});
