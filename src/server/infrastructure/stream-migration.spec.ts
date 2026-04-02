import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import type { JetStreamManager, StreamConfig, StreamInfo } from '@nats-io/jetstream';
import { JetStreamApiError, StorageType, RetentionPolicy } from '@nats-io/jetstream';

import { StreamMigration } from './stream-migration';

const streamNotFoundError = new JetStreamApiError({
  err_code: 10059,
  code: 404,
  description: 'stream not found',
});

describe(StreamMigration.name, () => {
  afterEach(vi.resetAllMocks);

  const newConfig = {
    name: 'test_ev-stream',
    subjects: ['test.ev.>'],
    storage: StorageType.Memory,
    retention: RetentionPolicy.Workqueue,
    num_replicas: 1,
  };

  const buildMockJsm = (messageCount: number): JetStreamManager => {
    const mockInfo = createMock<StreamInfo>({
      config: {
        name: 'test_ev-stream',
        storage: StorageType.File,
        retention: RetentionPolicy.Workqueue,
        subjects: ['test.ev.>'],
        num_replicas: 1,
      } as StreamConfig,
      state: { messages: messageCount } as StreamInfo['state'],
    });

    let infoCallCount = 0;

    return createMock<JetStreamManager>({
      streams: {
        info: vi.fn().mockImplementation(async (name: string) => {
          if (name.includes('__migration_backup')) {
            // Orphan check — not found (first call), subsequent: has messages
            if (infoCallCount++ === 0) {
              throw streamNotFoundError;
            }

            return {
              ...mockInfo,
              config: { ...mockInfo.config, name },
              state: { messages: messageCount },
            };
          }

          return mockInfo;
        }),
        add: vi.fn().mockResolvedValue(mockInfo),
        update: vi.fn().mockResolvedValue(mockInfo),
        delete: vi.fn().mockResolvedValue(true),
      },
    });
  };

  describe('empty stream', () => {
    it('should delete and create without sourcing', async () => {
      // Given
      const sut = new StreamMigration();
      const jsm = buildMockJsm(0);

      // When
      await sut.migrate(jsm, 'test_ev-stream', newConfig);

      // Then: delete + create, no backup sourcing
      expect(jsm.streams.delete).toHaveBeenCalledWith('test_ev-stream');
      expect(jsm.streams.add).toHaveBeenCalledWith(newConfig);

      // No backup stream created (only the new stream via add)
      expect(jsm.streams.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('stream with messages', () => {
    it('should create backup, delete, create new, restore, cleanup', async () => {
      // Given
      const sut = new StreamMigration();
      const jsm = buildMockJsm(100);

      // When
      await sut.migrate(jsm, 'test_ev-stream', newConfig);

      // Then: Phase 1 — backup created with sources
      const addCalls = vi.mocked(jsm.streams.add).mock.calls;

      expect(addCalls[0]![0]).toMatchObject({
        name: 'test_ev-stream__migration_backup',
        subjects: [],
      });

      // Phase 2 — delete original
      expect(jsm.streams.delete).toHaveBeenCalledWith('test_ev-stream');

      // Phase 3 — create new
      expect(addCalls[1]![0]).toMatchObject(newConfig);

      // Phase 4 — restore via sources, then remove sources, then delete backup
      expect(jsm.streams.update).toHaveBeenCalled();
      expect(jsm.streams.delete).toHaveBeenCalledWith('test_ev-stream__migration_backup');
    });
  });

  describe('orphaned backup cleanup', () => {
    it('should delete orphaned backup before starting migration', async () => {
      // Given: backup stream exists from previous failed migration
      const sut = new StreamMigration();
      const jsm = buildMockJsm(0);

      // Override: backup exists on first info call
      vi.mocked(jsm.streams.info).mockImplementation(async (name: string) => {
        if (name.includes('__migration_backup')) {
          return createMock<StreamInfo>({ state: { messages: 0 } as StreamInfo['state'] });
        }

        return createMock<StreamInfo>({
          state: { messages: 0 } as StreamInfo['state'],
          config: { name: 'test_ev-stream' } as StreamConfig,
        });
      });

      // When
      await sut.migrate(jsm, 'test_ev-stream', newConfig);

      // Then: backup deleted before migration
      const deleteCalls = vi.mocked(jsm.streams.delete).mock.calls.map((c) => c[0]);

      expect(deleteCalls).toContain('test_ev-stream__migration_backup');
    });
  });

  describe('Phase 2 failure (delete original fails)', () => {
    it('should cleanup backup and rethrow when delete original throws', async () => {
      // Given: stream with 100 messages, backup successfully created
      const sut = new StreamMigration();
      const jsm = buildMockJsm(100);

      // Override: delete throws on original stream name
      vi.mocked(jsm.streams.delete).mockImplementation(async (name: string) => {
        if (!name.includes('__migration_backup')) {
          throw new Error('permission denied');
        }

        return true;
      });

      // When/Then: error is rethrown
      await expect(sut.migrate(jsm, 'test_ev-stream', newConfig)).rejects.toThrow(
        'permission denied',
      );

      // And: cleanup — backup delete was called
      expect(jsm.streams.delete).toHaveBeenCalledWith('test_ev-stream__migration_backup');
    });
  });

  describe('Phase 3 failure (create new stream fails)', () => {
    it('should PRESERVE backup and rethrow (backup is the only copy after Phase 2)', async () => {
      // Given: stream with messages, backup + delete succeed, Phase 3 fails
      const sut = new StreamMigration();
      const jsm = buildMockJsm(100);

      let addCallCount = 0;

      // Override: second add call (new stream creation) throws
      vi.mocked(jsm.streams.add).mockImplementation(async () => {
        addCallCount++;
        if (addCallCount === 2) {
          throw new Error('resource limit exceeded');
        }

        return createMock<StreamInfo>();
      });

      // When/Then: error is rethrown
      await expect(sut.migrate(jsm, 'test_ev-stream', newConfig)).rejects.toThrow(
        'resource limit exceeded',
      );

      // And: backup NOT deleted — it's the only copy after original was deleted in Phase 2
      const deleteCalls = vi.mocked(jsm.streams.delete).mock.calls.map((c) => c[0]);

      expect(deleteCalls).not.toContain('test_ev-stream__migration_backup');
    });
  });

  describe('Phase 4 backup sources clearing', () => {
    it('should clear backup sources before restore to prevent detected-cycle error', async () => {
      // Given: stream with 100 messages
      const sut = new StreamMigration();
      const jsm = buildMockJsm(100);

      // When
      await sut.migrate(jsm, 'test_ev-stream', newConfig);

      // Then: first update call clears backup sources (cycle prevention)
      const updateCalls = vi.mocked(jsm.streams.update).mock.calls;
      const firstUpdateName = updateCalls[0]![0];
      const firstUpdateConfig = updateCalls[0]![1];

      expect(firstUpdateName).toBe('test_ev-stream__migration_backup');
      expect(firstUpdateConfig).toMatchObject({ sources: [] });

      // And: second update call restores with backup as source
      const secondUpdateName = updateCalls[1]![0];
      const secondUpdateConfig = updateCalls[1]![1];

      expect(secondUpdateName).toBe('test_ev-stream');
      expect(secondUpdateConfig).toMatchObject({
        sources: [{ name: 'test_ev-stream__migration_backup' }],
      });
    });

    it('should include full newConfig properties in restore update call', async () => {
      // Given: stream with 100 messages
      const sut = new StreamMigration();
      const jsm = buildMockJsm(100);

      // When
      await sut.migrate(jsm, 'test_ev-stream', newConfig);

      // Then: restore update passes full config AND sources
      const updateCalls = vi.mocked(jsm.streams.update).mock.calls;
      const restoreCall = updateCalls[1]![1];

      expect(restoreCall).toMatchObject({
        name: newConfig.name,
        subjects: newConfig.subjects,
        storage: newConfig.storage,
        retention: newConfig.retention,
        num_replicas: newConfig.num_replicas,
        sources: [{ name: 'test_ev-stream__migration_backup' }],
      });
    });
  });

  describe('sourcing timeout', () => {
    it('should throw and cleanup backup on timeout', async () => {
      // Given: backup never reaches expected message count
      const sut = new StreamMigration(1_000); // 1s timeout for test speed

      let backupCreated = false;

      const jsm = createMock<JetStreamManager>({
        streams: {
          info: vi.fn().mockImplementation(async (name: string) => {
            if (name.includes('__migration_backup') && !backupCreated) {
              throw streamNotFoundError;
            }

            if (name.includes('__migration_backup') && backupCreated) {
              // Always returns 0 messages — simulates stuck sourcing
              return createMock<StreamInfo>({ state: { messages: 0 } as StreamInfo['state'] });
            }

            return createMock<StreamInfo>({
              state: { messages: 100 } as StreamInfo['state'],
              config: { name: 'test_ev-stream' } as StreamConfig,
            });
          }),
          add: vi.fn().mockImplementation(async () => {
            backupCreated = true;

            return createMock<StreamInfo>();
          }),
          update: vi.fn().mockResolvedValue(createMock<StreamInfo>()),
          delete: vi.fn().mockResolvedValue(true),
        },
      });

      // When/Then: should throw timeout error
      await expect(sut.migrate(jsm, 'test_ev-stream', newConfig)).rejects.toThrow(
        /sourcing timeout/i,
      );

      // And: backup cleaned up — original stream was NOT deleted (Phase 1 timeout)
      expect(jsm.streams.delete).toHaveBeenCalledWith('test_ev-stream__migration_backup');
    });
  });
});
