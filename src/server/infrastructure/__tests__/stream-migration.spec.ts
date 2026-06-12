import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { JetStreamManager, StreamConfig, StreamInfo } from '@nats-io/jetstream';
import { JetStreamApiError, StorageType, RetentionPolicy } from '@nats-io/jetstream';

import { MIGRATION_BACKUP_SUFFIX, StreamMigration } from '../stream-migration';

const streamNotFoundError = new JetStreamApiError({
  err_code: 10059,
  code: 404,
  description: 'stream not found',
});

describe(StreamMigration.name, () => {
  afterEach(vi.resetAllMocks);

  const testStreamName = `${faker.lorem.word()}__microservice_ev-stream`;
  const backupStreamName = `${testStreamName}${MIGRATION_BACKUP_SUFFIX}`;

  const newConfig = {
    name: testStreamName,
    subjects: [`${testStreamName}.>`],
    storage: StorageType.Memory,
    retention: RetentionPolicy.Workqueue,
    num_replicas: 1,
  };

  /** A drained source entry as the server reports it after a full sync. */
  const drainedSources = [
    { name: testStreamName, lag: 0, active: 1_000 },
    { name: backupStreamName, lag: 0, active: 1_000 },
  ];

  const buildMockJsm = (messageCount: number): JetStreamManager => {
    const streamInfo = createMock<StreamInfo>({
      config: {
        name: testStreamName,
        storage: StorageType.File,
        retention: RetentionPolicy.Workqueue,
        subjects: ['test.ev.>'],
        num_replicas: 1,
      } as StreamConfig,
      state: { messages: messageCount } as StreamInfo['state'],
      sources: drainedSources,
    });

    let backupExists = false;

    return createMock<JetStreamManager>({
      streams: {
        info: vi.fn().mockImplementation(async (name: string) => {
          if (name === backupStreamName) {
            if (!backupExists) throw streamNotFoundError;

            return createMock<StreamInfo>({
              config: {
                name: backupStreamName,
                sources: [{ name: testStreamName }],
              } as unknown as StreamConfig,
              state: { messages: messageCount } as StreamInfo['state'],
              sources: drainedSources,
            });
          }

          return streamInfo;
        }),
        add: vi.fn().mockImplementation(async (config: StreamConfig) => {
          if (config.name === backupStreamName) backupExists = true;

          return createMock<StreamInfo>();
        }),
        update: vi.fn().mockResolvedValue(createMock<StreamInfo>()),
        delete: vi.fn().mockImplementation(async (name: string) => {
          if (name === backupStreamName) backupExists = false;

          return true;
        }),
      },
    });
  };

  describe('empty stream', () => {
    it('should quiesce, then delete and create without sourcing', async () => {
      // Given
      const sut = new StreamMigration();
      const jsm = buildMockJsm(0);

      // When
      await sut.migrate(jsm, testStreamName, newConfig);

      // Then: intake stopped before the count snapshot
      const firstUpdate = vi.mocked(jsm.streams.update).mock.calls[0]!;

      expect(firstUpdate[0]).toBe(testStreamName);
      expect(firstUpdate[1]).toMatchObject({ subjects: [] });

      // And: delete + create, no backup sourcing
      expect(jsm.streams.delete).toHaveBeenCalledWith(testStreamName);
      expect(jsm.streams.add).toHaveBeenCalledWith(newConfig);
      expect(jsm.streams.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('stream with messages', () => {
    it('should quiesce, back up, delete, create new, restore, cleanup', async () => {
      // Given
      const sut = new StreamMigration();
      const jsm = buildMockJsm(100);

      // When
      await sut.migrate(jsm, testStreamName, newConfig);

      // Then: backup created with sources and the migration metadata stamp
      const addCalls = vi.mocked(jsm.streams.add).mock.calls;

      expect(addCalls[0]![0]).toMatchObject({
        name: backupStreamName,
        subjects: [],
        sources: [{ name: testStreamName }],
      });
      expect(
        (addCalls[0]![0] as StreamConfig).metadata?.['nestjs-jetstream-migration-started-at'],
      ).toBeDefined();

      // And: original deleted, new stream created
      expect(jsm.streams.delete).toHaveBeenCalledWith(testStreamName);
      expect(addCalls[1]![0]).toMatchObject(newConfig);

      // And: restored from the backup, backup removed
      expect(jsm.streams.delete).toHaveBeenCalledWith(backupStreamName);
    });

    it('should clear backup sources before restore to prevent a sourcing cycle', async () => {
      // Given
      const sut = new StreamMigration();
      const jsm = buildMockJsm(100);

      // When
      await sut.migrate(jsm, testStreamName, newConfig);

      // Then: updates ordered quiesce → clear backup sources → attach restore
      const updateCalls = vi.mocked(jsm.streams.update).mock.calls;

      expect(updateCalls[0]![0]).toBe(testStreamName);
      expect(updateCalls[0]![1]).toMatchObject({ subjects: [] });

      expect(updateCalls[1]![0]).toBe(backupStreamName);
      expect(updateCalls[1]![1]).toMatchObject({ sources: [] });

      expect(updateCalls[2]![0]).toBe(testStreamName);
      expect(updateCalls[2]![1]).toMatchObject({ sources: [{ name: backupStreamName }] });
    });

    it('should delete the backup before detaching the restore source', async () => {
      // The order recovery relies on: "backup without an attached source"
      // can only mean the restore never started.
      const sut = new StreamMigration();
      const jsm = buildMockJsm(100);

      await sut.migrate(jsm, testStreamName, newConfig);

      const deleteBackupOrder = vi.mocked(jsm.streams.delete).mock.invocationCallOrder.at(-1)!;
      const detachOrder = vi.mocked(jsm.streams.update).mock.invocationCallOrder.at(-1)!;

      expect(deleteBackupOrder).toBeLessThan(detachOrder);
    });
  });

  describe('failure before the original is deleted', () => {
    it('should roll back the quiesce, drop the backup, and rethrow', async () => {
      // Given: deleting the original fails
      const sut = new StreamMigration();
      const jsm = buildMockJsm(100);

      vi.mocked(jsm.streams.delete).mockImplementation(async (name: string) => {
        if (name !== backupStreamName) {
          throw new Error('permission denied');
        }

        return true;
      });

      // When/Then
      await expect(sut.migrate(jsm, testStreamName, newConfig)).rejects.toThrow(
        'permission denied',
      );

      // And: the original's subjects were restored and the backup removed
      const lastUpdate = vi.mocked(jsm.streams.update).mock.calls.at(-1)!;

      expect(lastUpdate[0]).toBe(testStreamName);
      expect(lastUpdate[1]).toMatchObject({ subjects: ['test.ev.>'] });
      expect(jsm.streams.delete).toHaveBeenCalledWith(backupStreamName);
    });
  });

  describe('failure after the original is deleted', () => {
    it('should preserve the backup (it is the only copy) and rethrow', async () => {
      // Given: creating the new stream fails after the delete
      const sut = new StreamMigration();
      const jsm = buildMockJsm(100);

      let addCallCount = 0;
      const originalAdd = vi.mocked(jsm.streams.add).getMockImplementation()!;

      vi.mocked(jsm.streams.add).mockImplementation(async (config) => {
        addCallCount++;

        if (addCallCount === 2) {
          throw new Error('resource limit exceeded');
        }

        return originalAdd(config);
      });

      // When/Then
      await expect(sut.migrate(jsm, testStreamName, newConfig)).rejects.toThrow(
        'resource limit exceeded',
      );

      // And: backup NOT deleted
      const deleteCalls = vi.mocked(jsm.streams.delete).mock.calls.map((c) => c[0]);

      expect(deleteCalls).not.toContain(backupStreamName);
    });
  });

  describe('sourcing timeout', () => {
    it('should roll back and rethrow when the backup never drains', async () => {
      // Given: the backup's source entry never reports activity
      const sut = new StreamMigration(500);
      const jsm = buildMockJsm(100);
      const original = vi.mocked(jsm.streams.info).getMockImplementation()!;

      vi.mocked(jsm.streams.info).mockImplementation(async (name: string) => {
        const info = (await original(name)) as StreamInfo;

        if (name === backupStreamName) {
          return { ...info, sources: [{ name: testStreamName, lag: 0, active: -1 }] };
        }

        return info;
      });

      // When/Then
      await expect(sut.migrate(jsm, testStreamName, newConfig)).rejects.toThrow(
        /sourcing timeout/i,
      );

      // And: the original was not deleted; our backup was cleaned up
      const deleteCalls = vi.mocked(jsm.streams.delete).mock.calls.map((c) => c[0]);

      expect(deleteCalls).toContain(backupStreamName);
      expect(deleteCalls).not.toContain(testStreamName);
    });
  });

  describe('concurrent migration protection', () => {
    const freshBackupInfo = (): StreamInfo =>
      createMock<StreamInfo>({
        config: {
          name: backupStreamName,
          metadata: { 'nestjs-jetstream-migration-started-at': new Date().toISOString() },
        } as unknown as StreamConfig,
        state: { messages: 5 } as StreamInfo['state'],
      });

    it("should leave another instance's live backup alone during recovery", async () => {
      // Given: a backup stamped moments ago, a peer is migrating right now
      const sut = new StreamMigration(200, 200);
      const jsm = createMock<JetStreamManager>({
        streams: {
          info: vi.fn().mockResolvedValue(freshBackupInfo()),
          add: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
      });

      // When
      const recovered = await sut.recoverInterrupted(jsm, testStreamName, newConfig);

      // Then: nothing was touched
      expect(recovered).toBe(false);
      expect(jsm.streams.delete).not.toHaveBeenCalled();
      expect(jsm.streams.add).not.toHaveBeenCalled();
      expect(jsm.streams.update).not.toHaveBeenCalled();
    });

    it('should wait out a peer backup in migrate() and never delete it', async () => {
      // Given: the peer's backup never clears within the wait budget
      const sut = new StreamMigration(200, 200);
      const jsm = createMock<JetStreamManager>({
        streams: {
          info: vi.fn().mockImplementation(async (name: string) => {
            if (name === backupStreamName) return freshBackupInfo();

            return createMock<StreamInfo>();
          }),
          add: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
      });

      // When/Then: migrate gives up loudly instead of deleting the peer's data
      await expect(sut.migrate(jsm, testStreamName, newConfig)).rejects.toThrow(/did not clear/);

      expect(jsm.streams.delete).not.toHaveBeenCalled();
    });
  });

  describe('peer migration completed while waiting', () => {
    it('should apply the config without recreating when the peer result is compatible', async () => {
      // Given: the peer's backup clears on the second poll, and the stream it
      // left behind already matches the desired immutable properties
      const sut = new StreamMigration(200, 2_000);

      let backupPolls = 0;

      const jsm = createMock<JetStreamManager>({
        streams: {
          info: vi.fn().mockImplementation(async (name: string) => {
            if (name === backupStreamName) {
              backupPolls++;

              if (backupPolls > 1) throw streamNotFoundError;

              return createMock<StreamInfo>({
                config: { name: backupStreamName } as StreamConfig,
              });
            }

            return createMock<StreamInfo>({
              config: { ...newConfig } as StreamConfig,
            });
          }),
          add: vi.fn(),
          update: vi.fn().mockResolvedValue(createMock<StreamInfo>()),
          delete: vi.fn(),
        },
      });

      // When
      await sut.migrate(jsm, testStreamName, newConfig);

      // Then: mutable reconciliation only, nothing recreated
      expect(jsm.streams.update).toHaveBeenCalledWith(testStreamName, newConfig);
      expect(jsm.streams.add).not.toHaveBeenCalled();
      expect(jsm.streams.delete).not.toHaveBeenCalled();
    });
  });

  describe('rollback failure', () => {
    it('should propagate the original error when the rollback itself fails', async () => {
      // Given: deleting the original fails AND the quiesce rollback fails too
      const sut = new StreamMigration();
      const jsm = buildMockJsm(100);

      vi.mocked(jsm.streams.delete).mockRejectedValue(new Error('permission denied'));
      vi.mocked(jsm.streams.update).mockImplementation(async () => {
        // The first update is the quiesce; subsequent ones include the rollback
        if (vi.mocked(jsm.streams.update).mock.calls.length > 1) {
          throw new Error('connection lost');
        }

        return createMock<StreamInfo>();
      });

      // When/Then: the caller sees the migration failure, not the rollback one
      await expect(sut.migrate(jsm, testStreamName, newConfig)).rejects.toThrow(
        'permission denied',
      );
    });
  });

  describe('interrupted-migration recovery', () => {
    it('should recreate the stream and drop an empty backup after a delete/create crash', async () => {
      // Given: only an empty stale backup exists; the original was deleted
      // and held no messages when the process died
      const sut = new StreamMigration();
      const jsm = createMock<JetStreamManager>({
        streams: {
          info: vi.fn().mockImplementation(async (name: string) => {
            if (name === backupStreamName) {
              return createMock<StreamInfo>({
                config: { name: backupStreamName } as StreamConfig,
                state: { messages: 0 } as StreamInfo['state'],
              });
            }

            throw streamNotFoundError;
          }),
          add: vi.fn().mockResolvedValue(createMock<StreamInfo>()),
          update: vi.fn(),
          delete: vi.fn().mockResolvedValue(true),
        },
      });

      // When
      const recovered = await sut.recoverInterrupted(jsm, testStreamName, newConfig);

      // Then: stream recreated, backup removed, no restore wiring
      expect(recovered).toBe(true);
      expect(jsm.streams.add).toHaveBeenCalledWith(newConfig);
      expect(jsm.streams.delete).toHaveBeenCalledWith(backupStreamName);
      expect(jsm.streams.update).not.toHaveBeenCalled();
    });

    it('should finish a restore whose source is still attached', async () => {
      // Given: the stream still sources from the backup; the process died
      // mid-restore and the server kept the source position
      const sut = new StreamMigration();
      const jsm = createMock<JetStreamManager>({
        streams: {
          info: vi.fn().mockImplementation(async (name: string) => {
            if (name === backupStreamName) {
              return createMock<StreamInfo>({
                config: { name: backupStreamName } as StreamConfig,
                state: { messages: 5 } as StreamInfo['state'],
              });
            }

            return createMock<StreamInfo>({
              config: {
                name: testStreamName,
                sources: [{ name: backupStreamName }],
              } as unknown as StreamConfig,
              state: { messages: 5 } as StreamInfo['state'],
              sources: [{ name: backupStreamName, lag: 0, active: 1_000 }],
            });
          }),
          add: vi.fn(),
          update: vi.fn().mockResolvedValue(createMock<StreamInfo>()),
          delete: vi.fn().mockResolvedValue(true),
        },
      });

      // When
      const recovered = await sut.recoverInterrupted(jsm, testStreamName, newConfig);

      // Then: drained, backup removed, source detached, in that order
      expect(recovered).toBe(true);
      expect(jsm.streams.delete).toHaveBeenCalledWith(backupStreamName);

      const detachCall = vi.mocked(jsm.streams.update).mock.calls.at(-1)!;

      expect(detachCall[0]).toBe(testStreamName);
      expect(detachCall[1]).toMatchObject({ sources: [] });
      expect(vi.mocked(jsm.streams.delete).mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked(jsm.streams.update).mock.invocationCallOrder.at(-1)!,
      );
    });

    it('should delete a stale empty backup when the stream is healthy', async () => {
      // Given: an empty leftover backup without a freshness stamp
      const sut = new StreamMigration();
      const jsm = createMock<JetStreamManager>({
        streams: {
          info: vi.fn().mockImplementation(async (name: string) => {
            if (name === backupStreamName) {
              return createMock<StreamInfo>({
                config: { name: backupStreamName } as StreamConfig,
                state: { messages: 0 } as StreamInfo['state'],
              });
            }

            return createMock<StreamInfo>({
              config: { name: testStreamName } as StreamConfig,
            });
          }),
          add: vi.fn(),
          update: vi.fn(),
          delete: vi.fn().mockResolvedValue(true),
        },
      });

      // When
      const recovered = await sut.recoverInterrupted(jsm, testStreamName, newConfig);

      // Then
      expect(recovered).toBe(true);
      expect(jsm.streams.delete).toHaveBeenCalledWith(backupStreamName);
    });

    it('should report no recovery when no backup exists', async () => {
      // Given
      const sut = new StreamMigration();
      const jsm = createMock<JetStreamManager>({
        streams: {
          info: vi.fn().mockRejectedValue(streamNotFoundError),
          add: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
      });

      // When/Then
      await expect(sut.recoverInterrupted(jsm, testStreamName, newConfig)).resolves.toBe(false);
    });
  });
});
