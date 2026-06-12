import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { ConsumerInfo, StreamInfo } from '@nats-io/jetstream';
import { JetStreamApiError } from '@nats-io/jetstream';

import { ConnectionProvider } from '../../../connection';
import { ManagementMode, StreamKind } from '../../../interfaces';
import type { JetstreamModuleOptions } from '../../../interfaces';
import { internalName } from '../../../jetstream.constants';
import { PatternRegistry } from '../../routing';

import { ConsumerProvider } from '../consumer.provider';
import { InfrastructureBinder } from '../infrastructure-binder';
import { NameResolver } from '../name-resolver';
import { StreamProvider } from '../stream.provider';

describe(ConsumerProvider, () => {
  let sut: ConsumerProvider;

  let options: JetstreamModuleOptions;
  let connection: Mocked<ConnectionProvider>;
  let streamProvider: Mocked<StreamProvider>;
  let patternRegistry: Mocked<PatternRegistry>;
  let mockBinder: Mocked<InfrastructureBinder>;
  let mockJsm: {
    consumers: {
      info: ReturnType<typeof vi.fn>;
      add: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    streams: {
      info: ReturnType<typeof vi.fn>;
    };
  };

  const makeSut = (): ConsumerProvider =>
    new ConsumerProvider(
      options,
      connection,
      streamProvider,
      patternRegistry,
      new NameResolver(options),
      mockBinder,
    );

  beforeEach(() => {
    options = { name: faker.lorem.word(), servers: ['nats://localhost:4222'] };

    const streamNotFoundError = new JetStreamApiError({
      err_code: 10059,
      code: 404,
      description: 'stream not found',
    });

    mockJsm = {
      consumers: {
        info: vi.fn(),
        add: vi.fn(),
        update: vi.fn(),
      },
      streams: {
        // Default: no migration backup exists
        info: vi.fn().mockRejectedValue(streamNotFoundError),
      },
    };

    connection = createMock<ConnectionProvider>({
      getJetStreamManager: vi.fn().mockResolvedValue(mockJsm),
    });
    streamProvider = createMock<StreamProvider>({
      getStreamName: vi.fn().mockReturnValue('test-stream'),
    });
    patternRegistry = createMock<PatternRegistry>();
    mockBinder = createMock<InfrastructureBinder>();

    sut = makeSut();
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
      it('should fall back to info() on CONSUMER_ALREADY_EXISTS (10148)', async () => {
        // Given: info → not found, add → already exists (race)
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
        const existingInfo = createMock<ConsumerInfo>();

        // First info → not found, second info (after race) → found
        mockJsm.consumers.info
          .mockRejectedValueOnce(notFoundError)
          .mockResolvedValueOnce(existingInfo);
        mockJsm.consumers.add.mockRejectedValue(alreadyExistsError);

        // When
        const result = await sut.ensureConsumers([StreamKind.Event]);

        // Then: fell back to info, did NOT update (preserves other pod's config)
        expect(mockJsm.consumers.add).toHaveBeenCalledOnce();
        expect(mockJsm.consumers.update).not.toHaveBeenCalled();
        expect(result.get(StreamKind.Event)).toBe(existingInfo);
      });

      it('should wrap non-race add() failures into JetstreamProvisioningError', async () => {
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

        // When/Then: the API error is wrapped, not rethrown raw
        await expect(sut.ensureConsumers([StreamKind.Event])).rejects.toMatchObject({
          name: 'JetstreamProvisioningError',
          entity: 'consumer',
          errCode: 10025,
        });

        expect(mockJsm.consumers.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('recoverConsumer', () => {
    describe('when consumer exists', () => {
      it('should return info without updating config', async () => {
        // Given: consumer exists
        const existingInfo = createMock<ConsumerInfo>();

        mockJsm.consumers.info.mockResolvedValue(existingInfo);

        const jsm = await connection.getJetStreamManager();

        // When
        const result = await sut.recoverConsumer(jsm, StreamKind.Event);

        // Then: returned existing info, NEVER called update or add
        expect(result).toBe(existingInfo);
        expect(mockJsm.consumers.update).not.toHaveBeenCalled();
        expect(mockJsm.consumers.add).not.toHaveBeenCalled();
      });
    });

    describe('when consumer does not exist', () => {
      it('should create it without updating', async () => {
        // Given: consumer not found → create succeeds
        const notFoundError = new JetStreamApiError({
          err_code: 10014,
          code: 404,
          description: 'consumer not found',
        });
        const created = createMock<ConsumerInfo>();

        mockJsm.consumers.info.mockRejectedValue(notFoundError);
        mockJsm.consumers.add.mockResolvedValue(created);

        const jsm = await connection.getJetStreamManager();

        // When
        const result = await sut.recoverConsumer(jsm, StreamKind.Event);

        // Then: created, not updated
        expect(result).toBe(created);
        expect(mockJsm.consumers.add).toHaveBeenCalledOnce();
        expect(mockJsm.consumers.update).not.toHaveBeenCalled();
      });
    });

    describe('when consumer created by another pod during recovery', () => {
      it('should fall back to info without updating', async () => {
        // Given: info → not found, add → already exists, second info → found
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
        const existingInfo = createMock<ConsumerInfo>();

        mockJsm.consumers.info
          .mockRejectedValueOnce(notFoundError)
          .mockResolvedValueOnce(existingInfo);
        mockJsm.consumers.add.mockRejectedValue(alreadyExistsError);

        const jsm = await connection.getJetStreamManager();

        // When
        const result = await sut.recoverConsumer(jsm, StreamKind.Event);

        // Then: used existing, NEVER updated
        expect(result).toBe(existingInfo);
        expect(mockJsm.consumers.update).not.toHaveBeenCalled();
      });
    });
    describe('when migration is in progress', () => {
      it('should throw instead of creating consumer', async () => {
        // Given: backup stream exists (migration in progress)
        const backupInfo = createMock<StreamInfo>();

        mockJsm.streams.info.mockResolvedValue(backupInfo);

        const notFoundError = new JetStreamApiError({
          err_code: 10014,
          code: 404,
          description: 'consumer not found',
        });

        mockJsm.consumers.info.mockRejectedValue(notFoundError);

        const jsm = await connection.getJetStreamManager();

        // When / Then: throws "migration in progress"
        await expect(sut.recoverConsumer(jsm, StreamKind.Event)).rejects.toThrow(/being migrated/);

        // And: consumer was NOT created
        expect(mockJsm.consumers.add).not.toHaveBeenCalled();
      });
    });
  });

  describe('error wrapping', () => {
    it('should wrap a non-recoverable JetStreamApiError from consumers.add', async () => {
      // Given: consumer not found, then add fails with insufficient resources
      const notFound = new JetStreamApiError({
        err_code: 10014,
        code: 404,
        description: 'consumer not found',
      });
      const resourceErr = new JetStreamApiError({
        err_code: 10047,
        code: 500,
        description: 'insufficient resources',
      });

      mockJsm.consumers.info.mockRejectedValue(notFound);
      mockJsm.consumers.update.mockRejectedValue(notFound);
      mockJsm.consumers.add.mockRejectedValue(resourceErr);

      // When / Then
      await expect(sut.ensureConsumer(mockJsm as never, StreamKind.Event)).rejects.toMatchObject({
        name: 'JetstreamProvisioningError',
        entity: 'consumer',
        errCode: 10047,
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

    describe('Manual management', () => {
      it('should bind without add/update when the consumer is Manual', async () => {
        // Given
        options.events = { management: { consumer: ManagementMode.Manual } };
        sut = makeSut();
        mockBinder.bindConsumer.mockResolvedValue(
          createMock<ConsumerInfo>({
            config: {
              filter_subject: `${internalName(options.name)}.ev.>`,
            } as ConsumerInfo['config'],
          }),
        );

        // When
        await sut.ensureConsumers([StreamKind.Event]);

        // Then
        expect(mockJsm.consumers.add).not.toHaveBeenCalled();
        expect(mockJsm.consumers.update).not.toHaveBeenCalled();
      });

      it('recoverConsumer should throw externally-managed error and NEVER create for Manual consumers', async () => {
        // Given
        options.events = { management: { consumer: ManagementMode.Manual } };
        sut = makeSut();
        mockJsm.consumers.info.mockRejectedValue(
          new JetStreamApiError({
            err_code: 10014,
            code: 404,
            description: 'consumer not found',
          }),
        );

        const jsm = await connection.getJetStreamManager();

        // When/Then
        await expect(sut.recoverConsumer(jsm as never, StreamKind.Event)).rejects.toThrow(
          /externally managed/i,
        );

        expect(mockJsm.consumers.add).not.toHaveBeenCalled();
      });

      it('recoverConsumer should skip the migration-backup lock for Manual consumers', async () => {
        // Given
        options.events = { management: { consumer: ManagementMode.Manual } };
        sut = makeSut();

        const liveInfo = createMock<ConsumerInfo>();

        mockJsm.consumers.info.mockResolvedValue(liveInfo);

        const jsm = await connection.getJetStreamManager();

        // When
        const result = await sut.recoverConsumer(jsm as never, StreamKind.Event);

        // Then
        expect(result).toBe(liveInfo);

        expect(mockJsm.consumers.info).toHaveBeenCalled();

        expect(mockJsm.streams.info).not.toHaveBeenCalled();
      });

      it('recoverConsumer should rethrow unexpected lookup errors for Manual consumers', async () => {
        // Given: a non-404 infrastructure failure during rebind
        options.events = { management: { consumer: ManagementMode.Manual } };
        sut = makeSut();

        const boom = new Error('connection reset');

        mockJsm.consumers.info.mockRejectedValue(boom);

        const jsm = await connection.getJetStreamManager();

        // When/Then
        await expect(sut.recoverConsumer(jsm as never, StreamKind.Event)).rejects.toBe(boom);

        expect(mockJsm.consumers.add).not.toHaveBeenCalled();
      });
    });

    describe('ordered kind misuse', () => {
      it('should reject durable config for ordered consumers', async () => {
        // Given
        sut = makeSut();

        // When/Then
        await expect(sut.ensureConsumers([StreamKind.Ordered])).rejects.toThrow(/ephemeral/i);

        expect(mockJsm.consumers.add).not.toHaveBeenCalled();
      });
    });

    describe('when events have a custom subjectPrefix', () => {
      it('should use exact per-pattern filters instead of a wildcard', async () => {
        // Given: custom prefix on events, one registered pattern
        const customOptions: JetstreamModuleOptions = {
          name: 'orders',
          servers: ['nats://localhost:4222'],
          events: {
            consumer: { durable_name: 'company_worker' },
            subjectPrefix: 'company.orders.',
          },
        };
        const customNames = new NameResolver(customOptions);

        sut = new ConsumerProvider(
          customOptions,
          connection,
          streamProvider,
          patternRegistry,
          customNames,
          mockBinder,
        );

        patternRegistry.getEventPatterns.mockReturnValue(['order.created']);

        mockJsm.consumers.info.mockResolvedValue(createMock<ConsumerInfo>());

        const updated = createMock<ConsumerInfo>();

        mockJsm.consumers.update.mockResolvedValue(updated);

        // When: ensure event consumer
        await sut.ensureConsumers([StreamKind.Event]);

        // Then: consumer uses custom durable_name and exact filter_subject
        expect(mockJsm.consumers.update).toHaveBeenCalledWith(
          'test-stream',
          'company_worker',
          expect.objectContaining({
            durable_name: 'company_worker',
            filter_subject: 'company.orders.order.created',
          }),
        );
      });

      it('should switch to filter_subjects when several patterns are registered', async () => {
        // Given: custom prefix on events, two registered patterns
        const customOptions: JetstreamModuleOptions = {
          name: 'orders',
          servers: ['nats://localhost:4222'],
          events: {
            consumer: { durable_name: 'company_worker' },
            subjectPrefix: 'company.orders.',
          },
        };
        const customNames = new NameResolver(customOptions);

        sut = new ConsumerProvider(
          customOptions,
          connection,
          streamProvider,
          patternRegistry,
          customNames,
          mockBinder,
        );

        patternRegistry.getEventPatterns.mockReturnValue(['order.created', 'order.cancelled']);

        mockJsm.consumers.info.mockResolvedValue(createMock<ConsumerInfo>());
        mockJsm.consumers.update.mockResolvedValue(createMock<ConsumerInfo>());

        // When: ensure event consumer
        await sut.ensureConsumers([StreamKind.Event]);

        // Then: exact per-pattern filter list, no wildcard
        expect(mockJsm.consumers.update).toHaveBeenCalledWith(
          'test-stream',
          'company_worker',
          expect.objectContaining({
            durable_name: 'company_worker',
            filter_subjects: ['company.orders.order.created', 'company.orders.order.cancelled'],
          }),
        );
      });
    });
  });
});
