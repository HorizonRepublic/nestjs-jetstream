import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import type { JetStreamManager, StreamConfig, StreamInfo } from '@nats-io/jetstream';
import { StorageType, RetentionPolicy } from '@nats-io/jetstream';

import { StreamMigration } from './stream-migration';

describe(StreamMigration.name, () => {
  afterEach(vi.resetAllMocks);

  const newConfig = {
    name: 'test_ev-stream',
    subjects: ['test.ev.>'],
    storage: StorageType.Memory,
    retention: RetentionPolicy.Workqueue,
    num_replicas: 1,
  };

  const buildMockJsm = (messageCount: number) => {
    /* eslint-disable @typescript-eslint/naming-convention -- NATS API uses snake_case */
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
    /* eslint-enable @typescript-eslint/naming-convention */

    let infoCallCount = 0;

    return createMock<JetStreamManager>({
      streams: {
        info: vi.fn().mockImplementation(async (name: string) => {
          if (name.includes('__migration_backup')) {
            // First call: orphan check — not found
            if (infoCallCount++ === 0) {
              throw new Error('stream not found');
            }

            // Subsequent: backup stream has messages
            return { ...mockInfo, config: { ...mockInfo.config, name }, state: { messages: messageCount } };
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

  describe('sourcing timeout', () => {
    it('should throw and cleanup backup on timeout', async () => {
      // Given: backup never reaches expected message count
      const sut = new StreamMigration(1_000); // 1s timeout for test speed

      let backupCreated = false;

      const jsm = createMock<JetStreamManager>({
        streams: {
          info: vi.fn().mockImplementation(async (name: string) => {
            if (name.includes('__migration_backup') && !backupCreated) {
              throw new Error('stream not found');
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

      // And: cleanup backup
      expect(jsm.streams.delete).toHaveBeenCalledWith('test_ev-stream__migration_backup');
    });
  });
});
