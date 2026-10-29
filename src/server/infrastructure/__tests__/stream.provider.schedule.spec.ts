import { Logger } from '@nestjs/common';

import type { StreamInfo } from '@nats-io/jetstream';
import { DiscardPolicy, JetStreamApiError, RetentionPolicy, StorageType } from '@nats-io/jetstream';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { ConnectionProvider } from '../../../connection';
import { MigrationErrorReason } from '../../../errors';
import { StreamKind } from '../../../interfaces';
import type { JetstreamModuleOptions } from '../../../interfaces';
import { DEFAULT_SCHEDULE_STREAM_CONFIG, toNanos } from '../../../jetstream.constants';
import { PatternRegistry } from '../../routing';
import { InfrastructureBinder } from '../infrastructure-binder';
import { NameResolver } from '../name-resolver';
import { StreamProvider } from '../stream.provider';

const streamNotFound = (): JetStreamApiError =>
  new JetStreamApiError({ err_code: 10059, code: 404, description: 'stream not found' });

describe('StreamProvider schedule stream', () => {
  let options: JetstreamModuleOptions;
  let service: string;
  let mockJsm: { streams: Record<'info' | 'add' | 'update', ReturnType<typeof vi.fn>> };
  let connection: Mocked<ConnectionProvider>;

  const makeSut = (): StreamProvider => {
    const names = new NameResolver(options);

    return new StreamProvider(
      options,
      connection,
      names,
      new InfrastructureBinder(options, names, createMock<PatternRegistry>()),
    );
  };

  beforeEach(() => {
    service = faker.lorem.word();
    options = { name: service, servers: ['nats://localhost:4222'], dlq: false };
    mockJsm = { streams: { info: vi.fn(), add: vi.fn(), update: vi.fn() } };
    connection = createMock<ConnectionProvider>({
      getJetStreamManager: vi.fn().mockResolvedValue(mockJsm),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('should capture ticks and the recurring holder namespace by convention', () => {
    expect(makeSut().getSubjects(StreamKind.Schedule)).toEqual([
      `${service}__microservice.sched.>`,
      `${service}__microservice._cron.>`,
    ]);
  });

  it('should capture one wildcard under a custom prefix, which already covers the holders', () => {
    // Given
    options.schedule = { subjectPrefix: 'acme.cron' };

    // When / Then
    expect(makeSut().getSubjects(StreamKind.Schedule)).toEqual(['acme.cron.>']);
  });

  it('should create a stream that keeps holders forever and expires nothing by age', async () => {
    // Given
    mockJsm.streams.info.mockRejectedValue(streamNotFound());
    mockJsm.streams.add.mockResolvedValue(createMock<StreamInfo>());

    // When
    await makeSut().ensureStreams([StreamKind.Schedule]);

    // Then
    expect(mockJsm.streams.add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `${service}__microservice_sched-stream`,
        subjects: [`${service}__microservice.sched.>`, `${service}__microservice._cron.>`],
        retention: RetentionPolicy.Workqueue,
        discard: DiscardPolicy.Old,
        discard_new_per_subject: false,
        max_age: 0,
        max_bytes: 64 * 1024 * 1024,
        max_msg_size: 1024 * 1024,
        allow_msg_schedules: true,
        allow_msg_ttl: true,
      }),
    );
  });

  it('should merge user overrides into the defaults', async () => {
    // Given
    options.schedule = { stream: { max_bytes: 1024 * 1024 * 1024 } };
    mockJsm.streams.info.mockRejectedValue(streamNotFound());
    mockJsm.streams.add.mockResolvedValue(createMock<StreamInfo>());

    // When
    await makeSut().ensureStreams([StreamKind.Schedule]);

    // Then
    expect(mockJsm.streams.add).toHaveBeenCalledWith(
      expect.objectContaining({ max_bytes: 1024 * 1024 * 1024, max_age: 0 }),
    );
  });

  it('should warn when max_age is overridden, since an aged-out holder stops its schedule', async () => {
    // Given
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    options.schedule = { stream: { max_age: toNanos(7, 'days') } };
    mockJsm.streams.info.mockRejectedValue(streamNotFound());
    mockJsm.streams.add.mockResolvedValue(createMock<StreamInfo>());

    // When
    await makeSut().ensureStreams([StreamKind.Schedule]);

    // Then
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/max_age.*stops/i));
  });

  it('should refuse a destructive migration, which the server cannot do for a schedule stream', async () => {
    // Given an immutable diff and the migration flag on
    options.provisioning = { allowDestructiveMigration: true };

    const sut = makeSut();
    const name = `${service}__microservice_sched-stream`;

    mockJsm.streams.info.mockImplementation(async (stream: string) => {
      if (stream.endsWith('__migration_backup')) throw streamNotFound();

      return createMock<StreamInfo>({
        config: {
          ...DEFAULT_SCHEDULE_STREAM_CONFIG,
          name,
          subjects: sut.getSubjects(StreamKind.Schedule),
          storage: StorageType.Memory,
        },
      });
    });

    // When / Then
    await expect(sut.ensureStreams([StreamKind.Schedule])).rejects.toThrow(
      expect.objectContaining({
        name: 'JetstreamMigrationError',
        reason: MigrationErrorReason.ScheduleStream,
        message: expect.stringMatching(/schedule stream.*cannot be migrated/i),
      }),
    );
  });
});
