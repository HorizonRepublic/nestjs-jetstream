import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { StreamInfo } from '@nats-io/jetstream';
import { JetStreamApiError, RetentionPolicy, StorageType } from '@nats-io/jetstream';

import { ConnectionProvider } from '../../../connection';
import { ManagementMode, StreamKind } from '../../../interfaces';
import type { JetstreamModuleOptions, StreamConfigOverrides } from '../../../interfaces';
import {
  DEFAULT_BROADCAST_STREAM_CONFIG,
  DEFAULT_DLQ_STREAM_CONFIG,
  DEFAULT_EVENT_STREAM_CONFIG,
  internalName,
} from '../../../jetstream.constants';

import { InfrastructureBinder } from '../infrastructure-binder';
import { NameResolver } from '../name-resolver';
import { PatternRegistry } from '../../routing';
import { StreamProvider } from '../stream.provider';

describe(StreamProvider, () => {
  let sut: StreamProvider;

  let options: JetstreamModuleOptions;
  let connection: Mocked<ConnectionProvider>;
  let mockJsm: {
    streams: {
      info: ReturnType<typeof vi.fn>;
      add: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    getAccountInfo?: ReturnType<typeof vi.fn>;
  };

  const makeSut = (binder?: InfrastructureBinder): StreamProvider => {
    const names = new NameResolver(options);
    const resolvedBinder =
      binder ?? new InfrastructureBinder(options, names, createMock<PatternRegistry>());

    return new StreamProvider(options, connection, names, resolvedBinder);
  };

  beforeEach(() => {
    options = { name: faker.lorem.word(), servers: ['nats://localhost:4222'] };

    mockJsm = {
      streams: {
        info: vi.fn(),
        add: vi.fn(),
        update: vi.fn(),
      },
    };

    connection = createMock<ConnectionProvider>({
      getJetStreamManager: vi.fn().mockResolvedValue(mockJsm),
    });

    sut = makeSut();
  });

  afterEach(vi.resetAllMocks);

  const streamNotFound = (): JetStreamApiError =>
    new JetStreamApiError({
      err_code: 10059,
      code: 404,
      description: 'stream not found',
    });

  /** Resolve `info` for real streams; report migration backups as absent. */
  const mockStreamInfo = (info: StreamInfo): void => {
    mockJsm.streams.info.mockImplementation(async (name: string) => {
      if (name.endsWith('__migration_backup')) throw streamNotFound();

      return info;
    });
  };

  describe('getStreamName', () => {
    describe('when kind is Event', () => {
      it('should return the correct stream name', () => {
        // When
        const result = sut.getStreamName(StreamKind.Event);

        // Then
        expect(result).toBe(`${options.name}__microservice_ev-stream`);
      });
    });

    describe('when kind is Broadcast', () => {
      it('should return broadcast-stream', () => {
        // When
        const result = sut.getStreamName(StreamKind.Broadcast);

        // Then
        expect(result).toBe('broadcast-stream');
      });
    });
  });

  describe('getSubjects', () => {
    describe('when kind is Event without allow_msg_schedules', () => {
      it('should return only the event subject', () => {
        // Given: no stream overrides
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Event);

        // Then
        expect(subjects).toEqual([`${name}.ev.>`]);
      });
    });

    describe('when kind is Event with allow_msg_schedules: true', () => {
      it('should include the _sch namespace', () => {
        // Given: scheduling enabled via stream override
        options.events = { stream: { allow_msg_schedules: true } };
        sut = makeSut();
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Event);

        // Then
        expect(subjects).toEqual([`${name}.ev.>`, `${name}._sch.>`]);
      });
    });

    describe('when kind is Event with allow_msg_schedules: false in overrides', () => {
      it('should NOT include the _sch namespace', () => {
        // Given: scheduling explicitly disabled
        options.events = { stream: { allow_msg_schedules: false } };
        sut = makeSut();
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Event);

        // Then
        expect(subjects).toEqual([`${name}.ev.>`]);
        expect(subjects).not.toContain(`${name}._sch.>`);
      });
    });

    describe('when kind is Broadcast without allow_msg_schedules', () => {
      it('should return only broadcast.>', () => {
        // When
        const subjects = sut.getSubjects(StreamKind.Broadcast);

        // Then
        expect(subjects).toEqual(['broadcast.>']);
      });
    });

    describe('when kind is Broadcast with allow_msg_schedules: true', () => {
      it('should NOT add a schedule subject — broadcast.> already covers it', () => {
        options.broadcast = { stream: { allow_msg_schedules: true } };
        sut = makeSut();

        // When
        const subjects = sut.getSubjects(StreamKind.Broadcast);

        // Then
        expect(subjects).toEqual(['broadcast.>']);
      });
    });

    describe('when kind is Command', () => {
      it('should return only the command subject', () => {
        // Given
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Command);

        // Then
        expect(subjects).toEqual([`${name}.cmd.>`]);
      });
    });

    describe('when kind is Ordered', () => {
      it('should return only the ordered subject', () => {
        // Given
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Ordered);

        // Then
        expect(subjects).toEqual([`${name}.ordered.>`]);
      });

      it('should never include _sch even when broadcast has allow_msg_schedules enabled', () => {
        // Given: broadcast scheduling is enabled but Ordered should be unaffected
        options.broadcast = { stream: { allow_msg_schedules: true } };
        sut = makeSut();
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Ordered);

        // Then
        expect(subjects).toEqual([`${name}.ordered.>`]);
        expect(subjects.some((s) => s.includes('_sch'))).toBe(false);
      });
    });
  });

  describe('shared broadcast stream protection', () => {
    const sharedBroadcastConfig = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      ...DEFAULT_BROADCAST_STREAM_CONFIG,
      name: 'broadcast-stream',
      subjects: ['broadcast.>'],
      description: 'JetStream broadcast stream (shared across services)',
      ...overrides,
    });

    it('should not strip subjects or rewrite the description set by other services', async () => {
      // Given: the live stream has an extra subject broadcast.> does not cover
      mockStreamInfo(
        createMock<StreamInfo>({
          config: sharedBroadcastConfig({ subjects: ['broadcast.>', 'announcements.>'] }),
        }),
      );
      mockJsm.streams.update.mockResolvedValue(createMock<StreamInfo>());

      // When
      await sut.ensureStreams([StreamKind.Broadcast]);

      // Then: no update — the local config must not clobber the shared stream
      expect(mockJsm.streams.update).not.toHaveBeenCalled();
      expect(mockJsm.streams.add).not.toHaveBeenCalled();
    });

    it('should keep a literal subject that the catch-all does not match', async () => {
      // Given: NATS '>' matches one-or-more tokens, so broadcast.> does not cover 'broadcast'
      mockStreamInfo(
        createMock<StreamInfo>({
          config: sharedBroadcastConfig({ subjects: ['broadcast.>', 'broadcast'] }),
        }),
      );
      mockJsm.streams.update.mockResolvedValue(createMock<StreamInfo>());

      // When
      await sut.ensureStreams([StreamKind.Broadcast]);

      // Then
      expect(mockJsm.streams.update).not.toHaveBeenCalled();
    });

    it('should collapse subjects covered by a broader one out of the shared-stream union', async () => {
      // Given: the live stream still carries a legacy broadcast._sch.>
      mockStreamInfo(
        createMock<StreamInfo>({
          config: sharedBroadcastConfig({ subjects: ['broadcast.>', 'broadcast._sch.>'] }),
        }),
      );
      mockJsm.streams.update.mockResolvedValue(createMock<StreamInfo>());

      // When
      await sut.ensureStreams([StreamKind.Broadcast]);

      // Then: the redundant subject is healed away
      expect(mockJsm.streams.update).toHaveBeenCalledOnce();

      const updateArg = mockJsm.streams.update.mock.calls[0]![1] as { subjects: string[] };

      expect(updateArg.subjects).toEqual(['broadcast.>']);
    });

    it('should refuse destructive migration of the shared broadcast stream', async () => {
      // Given: an immutable diff on the shared stream and the migration flag on
      options.allowDestructiveMigration = true;
      sut = makeSut();

      mockStreamInfo(
        createMock<StreamInfo>({
          config: sharedBroadcastConfig({ storage: StorageType.Memory }),
        }),
      );

      // When/Then: recreating broadcast-stream would delete every other
      // service's durable consumers — fail loudly instead
      await expect(sut.ensureStreams([StreamKind.Broadcast])).rejects.toThrow(
        /broadcast-stream.*shared|shared.*broadcast-stream/i,
      );
    });
  });

  describe('ensureStreams', () => {
    describe('when the stream does not exist', () => {
      it('should create the stream', async () => {
        // Given: streams.info throws STREAM_NOT_FOUND
        const notFoundError = new JetStreamApiError({
          err_code: 10059,
          code: 404,
          description: 'stream not found',
        });

        mockJsm.streams.info.mockRejectedValue(notFoundError);

        const created = createMock<StreamInfo>();

        mockJsm.streams.add.mockResolvedValue(created);

        // When
        await sut.ensureStreams([StreamKind.Event]);

        // Then
        expect(mockJsm.streams.add).toHaveBeenCalledOnce();
        expect(mockJsm.streams.update).not.toHaveBeenCalled();
      });
    });

    describe('when the stream already exists', () => {
      it('should skip update when config is unchanged', async () => {
        // Given: streams.info resolves with config matching defaults (no diff)
        const name = `${internalName(options.name)}_ev-stream`;
        const existingInfo = createMock<StreamInfo>({
          config: {
            ...DEFAULT_EVENT_STREAM_CONFIG,
            name,
            subjects: [`${internalName(options.name)}.ev.>`],
            description: `JetStream ev stream for ${options.name}`,
          },
        });

        mockStreamInfo(existingInfo);

        const updated = createMock<StreamInfo>();

        mockJsm.streams.update.mockResolvedValue(updated);

        // When
        await sut.ensureStreams([StreamKind.Event]);

        // Then: no changes detected — neither update nor add should be called
        expect(mockJsm.streams.update).not.toHaveBeenCalled();
        expect(mockJsm.streams.add).not.toHaveBeenCalled();
      });

      it('should apply mutable-only changes via streams.update', async () => {
        // Given: stream exists with different max_age
        const name = `${internalName(options.name)}_ev-stream`;
        const existingConfig = {
          ...DEFAULT_EVENT_STREAM_CONFIG,
          name,
          subjects: [`${internalName(options.name)}.ev.>`],
          description: `JetStream ev stream for ${options.name}`,
          max_age: 999,
        };

        mockStreamInfo(createMock<StreamInfo>({ config: existingConfig }));
        mockJsm.streams.update.mockResolvedValue(createMock<StreamInfo>());

        // When
        await sut.ensureStreams([StreamKind.Event]);

        // Then
        expect(mockJsm.streams.update).toHaveBeenCalledOnce();
        expect(mockJsm.streams.add).not.toHaveBeenCalled();
      });

      it('should skip immutable change when allowDestructiveMigration is off', async () => {
        // Given: stream exists with different storage
        const name = `${internalName(options.name)}_ev-stream`;
        const existingConfig = {
          ...DEFAULT_EVENT_STREAM_CONFIG,
          name,
          subjects: [`${internalName(options.name)}.ev.>`],
          description: `JetStream ev stream for ${options.name}`,
          storage: StorageType.Memory,
        };

        mockStreamInfo(createMock<StreamInfo>({ config: existingConfig }));

        // When (allowDestructiveMigration is false by default)
        await sut.ensureStreams([StreamKind.Event]);

        // Then: neither update nor add called (immutable skipped, no mutable changes)
        expect(mockJsm.streams.update).not.toHaveBeenCalled();
        expect(mockJsm.streams.add).not.toHaveBeenCalled();
      });

      it('should apply mutable changes while skipping immutable when flag is off', async () => {
        // Given: stream exists with different storage AND max_age
        const name = `${internalName(options.name)}_ev-stream`;
        const existingConfig = {
          ...DEFAULT_EVENT_STREAM_CONFIG,
          name,
          subjects: [`${internalName(options.name)}.ev.>`],
          description: `JetStream ev stream for ${options.name}`,
          storage: StorageType.Memory,
          max_age: 999,
        };

        mockStreamInfo(createMock<StreamInfo>({ config: existingConfig }));
        mockJsm.streams.update.mockResolvedValue(createMock<StreamInfo>());

        // When
        await sut.ensureStreams([StreamKind.Event]);

        // Then: update IS called, with the existing (Memory) storage preserved
        expect(mockJsm.streams.update).toHaveBeenCalledOnce();

        const updateArg = mockJsm.streams.update.mock.calls[0]![1] as Record<string, unknown>;

        expect(updateArg.storage).toBe(StorageType.Memory);
      });
    });

    describe('when stream has transport-controlled conflict', () => {
      it('should throw when existing stream retention differs from expected', async () => {
        // Given: stream exists with Limits retention, but transport expects Workqueue
        const name = `${internalName(options.name)}_ev-stream`;
        const existingConfig = {
          ...DEFAULT_EVENT_STREAM_CONFIG,
          name,
          subjects: [`${internalName(options.name)}.ev.>`],
          description: `JetStream ev stream for ${options.name}`,
          retention: RetentionPolicy.Limits,
        };

        mockStreamInfo(createMock<StreamInfo>({ config: existingConfig }));

        // When / Then
        await expect(sut.ensureStreams([StreamKind.Event])).rejects.toThrow(
          /transport-controlled config conflicts/,
        );

        expect(mockJsm.streams.update).not.toHaveBeenCalled();
        expect(mockJsm.streams.add).not.toHaveBeenCalled();
      });
    });

    describe('stripTransportControlled', () => {
      it('should silently strip retention from user overrides', async () => {
        // Given: options include retention override (bypassing TypeScript via cast)
        options = {
          ...options,
          events: {
            stream: { retention: RetentionPolicy.Limits } as unknown as StreamConfigOverrides,
          },
        };
        sut = makeSut();

        const notFoundError = new JetStreamApiError({
          err_code: 10059,
          code: 404,
          description: 'stream not found',
        });

        mockJsm.streams.info.mockRejectedValue(notFoundError);
        mockJsm.streams.add.mockResolvedValue(createMock<StreamInfo>());

        // When
        await sut.ensureStreams([StreamKind.Event]);

        // Then: the config passed to streams.add should have Workqueue retention (from default), not Limits
        const addArg = mockJsm.streams.add.mock.calls[0]![0] as Record<string, unknown>;

        expect(addArg.retention).toBe(RetentionPolicy.Workqueue);
      });
    });

    describe('when streams.info throws a non-STREAM_NOT_FOUND error', () => {
      it('should rethrow the error', async () => {
        // Given: jsm.streams.info throws an unexpected error
        const authError = new JetStreamApiError({
          err_code: 10100,
          code: 403,
          description: 'authorization violation',
        });

        mockJsm.streams.info.mockRejectedValue(authError);

        // When / Then
        await expect(sut.ensureStreams([StreamKind.Event])).rejects.toThrow(
          'authorization violation',
        );
        expect(mockJsm.streams.add).not.toHaveBeenCalled();
        expect(mockJsm.streams.update).not.toHaveBeenCalled();
      });
    });

    describe('when options.dlq is enabled', () => {
      describe('when the DLQ stream does not exist', () => {
        it('should create the DLQ stream', async () => {
          // Given: options with dlq enabled
          options = { ...options, dlq: {} };
          sut = makeSut();

          const notFoundError = new JetStreamApiError({
            err_code: 10059,
            code: 404,
            description: 'stream not found',
          });

          mockJsm.streams.info.mockRejectedValue(notFoundError);
          mockJsm.streams.add.mockResolvedValue(createMock<StreamInfo>());

          // When
          await sut.ensureStreams([StreamKind.Event]);

          // Then: both the regular stream AND the DLQ stream are created
          const expectedDlqName = `${internalName(options.name)}_dlq-stream`;

          expect(mockJsm.streams.info).toHaveBeenCalledWith(expectedDlqName);

          const dlqAddArg = mockJsm.streams.add.mock.calls
            .map(([config]) => config as Record<string, unknown>)
            .find((config) => config.name === expectedDlqName);

          expect(dlqAddArg).toMatchObject({
            name: expectedDlqName,
            subjects: [expectedDlqName],
            retention: DEFAULT_DLQ_STREAM_CONFIG.retention,
          });
        });
      });

      describe('when the DLQ stream already exists with no config changes', () => {
        it('should skip update for the DLQ stream', async () => {
          // Given: both regular stream and DLQ stream already exist with matching config
          options = { ...options, dlq: {} };
          sut = makeSut();

          // Event stream is absent (gets created); the DLQ stream exists
          const existingDlqInfo = createMock<StreamInfo>({
            config: {
              ...DEFAULT_DLQ_STREAM_CONFIG,
              name: `${options.name}__microservice_dlq-stream`,
              subjects: [`${options.name}__microservice_dlq-stream`],
              description: `JetStream DLQ stream for ${options.name}`,
            } as StreamInfo['config'],
          });

          mockJsm.streams.info.mockImplementation(async (name: string) => {
            if (name.endsWith('_dlq-stream')) return existingDlqInfo;

            throw streamNotFound();
          });

          mockJsm.streams.add.mockResolvedValue(createMock<StreamInfo>());

          // When
          await sut.ensureStreams([StreamKind.Event]);

          // Then: event stream created, DLQ stream not updated
          expect(mockJsm.streams.add).toHaveBeenCalledTimes(1);
          expect(mockJsm.streams.update).not.toHaveBeenCalled();
        });
      });

      describe('when the DLQ stream has an unexpected info error', () => {
        it('should rethrow the error from ensureDlqStream', async () => {
          // Given: options with dlq, but DLQ stream.info throws auth error
          options = { ...options, dlq: {} };
          sut = makeSut();

          const notFoundError = new JetStreamApiError({
            err_code: 10059,
            code: 404,
            description: 'stream not found',
          });
          const authError = new JetStreamApiError({
            err_code: 10100,
            code: 403,
            description: 'authorization violation for DLQ',
          });

          mockJsm.streams.info
            .mockRejectedValueOnce(notFoundError) // event stream → create
            .mockRejectedValueOnce(authError); // DLQ stream → rethrow

          mockJsm.streams.add.mockResolvedValue(createMock<StreamInfo>());

          // When / Then
          await expect(sut.ensureStreams([StreamKind.Event])).rejects.toThrow(
            'authorization violation for DLQ',
          );
        });
      });
    });
  });

  describe('ensureStreams', () => {
    it('should wrap an insufficient-storage failure from streams.add', async () => {
      // Given: stream does not exist, then add fails with insufficient storage
      const notFound = new JetStreamApiError({
        err_code: 10059,
        code: 404,
        description: 'stream not found',
      });
      const storageErr = new JetStreamApiError({
        err_code: 10047,
        code: 500,
        description: 'insufficient storage resources available',
      });

      mockJsm.streams.info.mockRejectedValue(notFound);
      mockJsm.streams.add.mockRejectedValue(storageErr);

      // When / Then
      await expect(sut.ensureStreams([StreamKind.Event])).rejects.toMatchObject({
        name: 'JetstreamProvisioningError',
        errCode: 10047,
        entity: 'stream',
      });
    });

    it('should run the preflight check only when provisioning.preflightStorageCheck is set', async () => {
      // Given: existing stream with no diff, preflight enabled
      options.provisioning = { preflightStorageCheck: true };
      sut = makeSut();

      const getAccountInfo = vi.fn().mockResolvedValue({
        storage: 0,
        reserved_storage: 0,
        memory: 0,
        reserved_memory: 0,
        streams: 0,
        consumers: 0,
        limits: { max_storage: -1, max_memory: 0 },
        api: { total: 0, errors: 0 },
      });

      mockJsm.getAccountInfo = getAccountInfo;
      mockStreamInfo({
        config: { ...DEFAULT_EVENT_STREAM_CONFIG, name: sut.getStreamName(StreamKind.Event) },
      } as never);

      // When
      await sut.ensureStreams([StreamKind.Event]);

      // Then
      expect(getAccountInfo).toHaveBeenCalledOnce();
    });
  });

  describe('custom naming', () => {
    it('should create the event stream under the custom name and prefix subjects', async () => {
      options.events = {
        stream: { name: 'company_orders_stream' },
        subjectPrefix: 'company.orders.',
      };
      sut = makeSut();

      mockJsm.streams.info.mockRejectedValue(streamNotFound());
      mockJsm.streams.add.mockResolvedValue(createMock<StreamInfo>());

      await sut.ensureStreams([StreamKind.Event]);

      const added = mockJsm.streams.add.mock.calls[0]![0] as { name: string; subjects: string[] };

      expect(added.name).toBe('company_orders_stream');
      expect(added.subjects).toEqual(['company.orders.>']);
    });

    it('should not emit a separate schedule subject under a custom prefix', async () => {
      options.events = {
        stream: { allow_msg_schedules: true },
        subjectPrefix: 'company.orders.',
      };
      sut = makeSut();

      expect(sut.getSubjects(StreamKind.Event)).toEqual(['company.orders.>']);
    });
  });

  describe('Manual management', () => {
    it('should bind without add/update/migration when the stream is Manual', async () => {
      // Given
      options.events = { management: { stream: ManagementMode.Manual } };
      sut = makeSut();
      mockStreamInfo(
        createMock<StreamInfo>({
          config: {
            name: `${options.name}__microservice_ev-stream`,
            retention: RetentionPolicy.Workqueue,
            subjects: [`${internalName(options.name)}.ev.>`],
          } as StreamInfo['config'],
        }),
      );

      // When
      await sut.ensureStreams([StreamKind.Event]);

      // Then
      expect(mockJsm.streams.add).not.toHaveBeenCalled();
      expect(mockJsm.streams.update).not.toHaveBeenCalled();
    });

    it('should throw when a Manual stream is missing', async () => {
      // Given
      options.events = { management: { stream: ManagementMode.Manual } };
      sut = makeSut();
      mockJsm.streams.info.mockRejectedValue(streamNotFound());

      // When / Then
      await expect(sut.ensureStreams([StreamKind.Event])).rejects.toThrow(/[Mm]anual/);
      expect(mockJsm.streams.add).not.toHaveBeenCalled();
    });

    it('should skip migration recovery for Manual streams', async () => {
      // Given: global Manual; live stream exists
      options.provisioning = { management: ManagementMode.Manual };
      sut = makeSut();
      mockStreamInfo(
        createMock<StreamInfo>({
          config: {
            name: `${options.name}__microservice_ev-stream`,
            retention: RetentionPolicy.Workqueue,
            subjects: [`${internalName(options.name)}.ev.>`],
          } as StreamInfo['config'],
        }),
      );

      // When
      await sut.ensureStreams([StreamKind.Event]);

      // Then: streams.info was never called for a migration_backup name
      const infoCallNames = mockJsm.streams.info.mock.calls.map(
        ([name]: [string]) => name,
      );

      expect(infoCallNames.every((n: string) => !n.includes('__migration_backup'))).toBe(true);
    });

    it('should exclude Manual streams from storage reservations and show them as external', async () => {
      // Given: global Manual + preflightStorageCheck enabled
      options.provisioning = { management: ManagementMode.Manual, preflightStorageCheck: true };
      sut = makeSut();

      const getAccountInfo = vi.fn();

      mockJsm.getAccountInfo = getAccountInfo;
      mockStreamInfo(
        createMock<StreamInfo>({
          config: {
            name: `${options.name}__microservice_ev-stream`,
            retention: RetentionPolicy.Workqueue,
            subjects: [`${internalName(options.name)}.ev.>`],
          } as StreamInfo['config'],
        }),
      );

      const logSpy = vi.spyOn(Logger.prototype, 'log');

      // When
      await sut.ensureStreams([StreamKind.Event]);

      // Then: no storage budget check for all-Manual setup
      expect(getAccountInfo).not.toHaveBeenCalled();

      // And the summary contains an external marker
      const summaryLog = logSpy.mock.calls
        .map(([msg]: [unknown]) => String(msg))
        .find((m: string) => m.includes(options.name) && m.includes('external'));

      expect(summaryLog).toBeDefined();
    });
  });

  describe('getSubjects (via ensureStreams)', () => {
    describe('when kind is Command with rpc.mode=jetstream and stream overrides', () => {
      it('should use rpc.stream overrides for command stream', async () => {
        // Given: rpc jetstream mode with max_age override
        options = {
          ...options,
          rpc: { mode: 'jetstream', stream: { max_age: 60_000 } },
        };
        sut = makeSut();

        const notFoundError = new JetStreamApiError({
          err_code: 10059,
          code: 404,
          description: 'stream not found',
        });

        mockJsm.streams.info.mockRejectedValue(notFoundError);
        mockJsm.streams.add.mockResolvedValue(createMock<StreamInfo>());

        // When
        await sut.ensureStreams([StreamKind.Command]);

        // Then: stream created with the overridden max_age
        const addArg = mockJsm.streams.add.mock.calls[0]![0] as Record<string, unknown>;

        expect(addArg.max_age).toBe(60_000);
      });
    });

    describe('when kind is Command with rpc.mode !== jetstream', () => {
      it('should use empty overrides for command stream', async () => {
        // Given: rpc nats mode (no jetstream command stream)
        options = {
          ...options,
          rpc: { mode: 'core', stream: { max_age: 99_999 } } as never,
        };
        sut = makeSut();

        const notFoundError = new JetStreamApiError({
          err_code: 10059,
          code: 404,
          description: 'stream not found',
        });

        mockJsm.streams.info.mockRejectedValue(notFoundError);
        mockJsm.streams.add.mockResolvedValue(createMock<StreamInfo>());

        // When: create the command stream anyway
        await sut.ensureStreams([StreamKind.Command]);

        // Then: stream created with defaults (no user overrides applied)
        expect(mockJsm.streams.add).toHaveBeenCalledOnce();
        const addArg = mockJsm.streams.add.mock.calls[0]![0] as Record<string, unknown>;

        expect(addArg.max_age).not.toBe(99_999);
      });
    });

    describe('when kind is Ordered with stream overrides', () => {
      it('should apply ordered.stream overrides', async () => {
        // Given: ordered stream with max_age override
        options = {
          ...options,
          ordered: { stream: { max_age: 30_000 } },
        };
        sut = makeSut();

        const notFoundError = new JetStreamApiError({
          err_code: 10059,
          code: 404,
          description: 'stream not found',
        });

        mockJsm.streams.info.mockRejectedValue(notFoundError);
        mockJsm.streams.add.mockResolvedValue(createMock<StreamInfo>());

        // When
        await sut.ensureStreams([StreamKind.Ordered]);

        // Then: stream created with the overridden max_age
        const addArg = mockJsm.streams.add.mock.calls[0]![0] as Record<string, unknown>;

        expect(addArg.max_age).toBe(30_000);
      });
    });
  });
});
