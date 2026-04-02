import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { ConsumerInfo } from '@nats-io/jetstream';
import { JetStreamApiError } from '@nats-io/jetstream';

import { ConnectionProvider } from '../../connection';
import { StreamKind } from '../../interfaces';
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

  afterEach(vi.resetAllMocks);

  describe('ensureConsumer', () => {
    describe('when consumer info throws a non-CONSUMER_NOT_FOUND error', () => {
      it('should rethrow the error', async () => {
        // Given: jsm.consumers.info throws auth error
        const authError = new JetStreamApiError({
          err_code: 10100,
          code: 403,
          description: 'authorization violation',
        });

        mockJsm.consumers.info.mockRejectedValue(authError);

        // When/Then: propagates the error
        await expect(sut.ensureConsumers([StreamKind.Event])).rejects.toThrow(
          'authorization violation',
        );
        expect(mockJsm.consumers.add).not.toHaveBeenCalled();
      });
    });

    describe('when consumer add() hits race condition (another pod created it)', () => {
      it('should fall back to update() on CONSUMER_ALREADY_EXISTS (10148)', async () => {
        // Given: info → not found, add → already exists (race), update → succeeds
        const notFoundError = new JetStreamApiError({
          err_code: 10014,
          code: 404,
          description: 'consumer not found',
        });
        const alreadyExistsError = new JetStreamApiError({
          err_code: 10148,
          code: 400,
          description: 'consumer already exists',
        });

        mockJsm.consumers.info.mockRejectedValue(notFoundError);
        mockJsm.consumers.add.mockRejectedValue(alreadyExistsError);

        const updated = createMock<ConsumerInfo>();

        mockJsm.consumers.update.mockResolvedValue(updated);

        // When
        const result = await sut.ensureConsumers([StreamKind.Event]);

        // Then: fell back to update after race
        expect(mockJsm.consumers.add).toHaveBeenCalledOnce();
        expect(mockJsm.consumers.update).toHaveBeenCalledOnce();
        expect(result.get(StreamKind.Event)).toBe(updated);
      });

      it('should rethrow non-race errors from add()', async () => {
        // Given: info → not found, add → resource limit (not a race)
        const notFoundError = new JetStreamApiError({
          err_code: 10014,
          code: 404,
          description: 'consumer not found',
        });
        const resourceError = new JetStreamApiError({
          err_code: 10025,
          code: 400,
          description: 'resource limits exceeded',
        });

        mockJsm.consumers.info.mockRejectedValue(notFoundError);
        mockJsm.consumers.add.mockRejectedValue(resourceError);

        // When/Then: error propagates, no fallback to update
        await expect(sut.ensureConsumers([StreamKind.Event])).rejects.toThrow(
          'resource limits exceeded',
        );

        expect(mockJsm.consumers.update).not.toHaveBeenCalled();
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
        await sut.ensureConsumers([StreamKind.Broadcast]);

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
        await sut.ensureConsumers([StreamKind.Broadcast]);

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
        const notFoundError = new JetStreamApiError({
          err_code: 10014,
          code: 404,
          description: 'consumer not found',
        });

        mockJsm.consumers.info.mockRejectedValue(notFoundError);

        const patterns = ['broadcast.a', 'broadcast.b'];

        patternRegistry.getBroadcastPatterns.mockReturnValue(patterns);

        const created = createMock<ConsumerInfo>();

        mockJsm.consumers.add.mockResolvedValue(created);

        // When: ensure broadcast consumer
        await sut.ensureConsumers([StreamKind.Broadcast]);

        // Then: created with filter_subjects
        expect(mockJsm.consumers.add).toHaveBeenCalledWith(
          'test-stream',
          expect.objectContaining({ filter_subjects: patterns }),
        );
      });
    });

    describe('when ordered kind is passed', () => {
      it('should throw because ordered consumers are ephemeral', async () => {
        // When/Then: getDefaults('ordered') throws synchronously before any NATS call
        await expect(sut.ensureConsumers([StreamKind.Ordered])).rejects.toThrow(/ephemeral/i);
      });
    });

    describe('when broadcast has zero patterns', () => {
      it('should throw because a broadcast consumer requires at least one pattern', async () => {
        // Given: registry returns empty broadcast patterns
        patternRegistry.getBroadcastPatterns.mockReturnValue([]);

        mockJsm.consumers.info.mockResolvedValue(createMock<ConsumerInfo>());

        // When/Then: ensureConsumers throws
        await expect(sut.ensureConsumers([StreamKind.Broadcast])).rejects.toThrow(
          /no broadcast patterns/i,
        );
        expect(mockJsm.consumers.add).not.toHaveBeenCalled();
        expect(mockJsm.consumers.update).not.toHaveBeenCalled();
      });
    });
  });
});
