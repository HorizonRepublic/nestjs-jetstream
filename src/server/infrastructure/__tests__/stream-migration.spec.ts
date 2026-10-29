import type {
  JetStreamManager,
  StreamConfig,
  StreamInfo,
  StreamSourceInfo,
} from '@nats-io/jetstream';
import { JetStreamApiError, RetentionPolicy, StorageType } from '@nats-io/jetstream';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MigrationErrorReason } from '../../../errors';
import {
  MIGRATION_BACKUP_SUFFIX,
  MIGRATION_HEARTBEAT_KEY,
  MIGRATION_PHASE_KEY,
  StreamMigration,
} from '../stream-migration';
import { MigrationPhase } from '../stream-migration.types';

const FAST = { heartbeatIntervalMs: 20, abandonedAfterMs: 100, stallTimeoutMs: 200 };

const notFound = (): JetStreamApiError =>
  new JetStreamApiError({ err_code: 10059, code: 404, description: 'stream not found' });

const alreadyExists = (): JetStreamApiError =>
  new JetStreamApiError({
    err_code: 10058,
    code: 400,
    description: 'stream name already in use with a different configuration',
  });

type StreamAddConfig = Parameters<JetStreamManager['streams']['add']>[0];

interface FakeStream {
  config: StreamAddConfig;
  messages: number;
}

/** Reports a source's lag; the default copies instantly. */
type SourceLag = (streamName: string, sourceName: string) => number;

/**
 * A JetStream manager over an in-memory set of streams. Sourcing copies a
 * source's message count once `sourceLag` reports 0, and `update` merges into
 * the current config the way nats.js does.
 */
const createFakeJsm = (
  streams: Map<string, FakeStream>,
  sourceLag: SourceLag = () => 0,
): JetStreamManager => {
  const info = vi.fn(async (name: string): Promise<StreamInfo> => {
    const stream = streams.get(name);

    if (!stream) throw notFound();

    const sources: StreamSourceInfo[] = (stream.config.sources ?? []).map((source) => {
      const lag = sourceLag(name, source.name);
      const origin = streams.get(source.name);

      if (lag === 0 && origin) stream.messages = Math.max(stream.messages, origin.messages);

      return createMock<StreamSourceInfo>({ name: source.name, lag, active: 1_000 });
    });

    return createMock<StreamInfo>({
      config: structuredClone(stream.config),
      state: { messages: stream.messages, bytes: stream.messages * 100 } as StreamInfo['state'],
      sources,
    });
  });

  return createMock<JetStreamManager>({
    streams: {
      info,
      add: vi.fn(async (config: StreamAddConfig): Promise<StreamInfo> => {
        if (streams.has(config.name)) throw alreadyExists();

        streams.set(config.name, { config: structuredClone(config), messages: 0 });

        return info(config.name);
      }),
      update: vi.fn(async (name: string, config: Partial<StreamConfig>): Promise<StreamInfo> => {
        const stream = streams.get(name);

        if (!stream) throw notFound();

        stream.config = { ...stream.config, ...structuredClone(config) };

        return info(name);
      }),
      delete: vi.fn(async (name: string): Promise<boolean> => {
        if (!streams.delete(name)) throw notFound();

        return true;
      }),
    },
  });
};

describe(StreamMigration, () => {
  afterEach(vi.resetAllMocks);

  const streamName = `${faker.lorem.word()}__microservice_ev-stream`;
  const backupName = `${streamName}${MIGRATION_BACKUP_SUFFIX}`;
  const subjects = [`${streamName}.>`];

  const desired = {
    name: streamName,
    subjects,
    storage: StorageType.Memory,
    retention: RetentionPolicy.Workqueue,
  };

  const original = (messages: number): FakeStream => ({
    config: {
      name: streamName,
      subjects,
      storage: StorageType.File,
      retention: RetentionPolicy.Workqueue,
    } as StreamConfig,
    messages,
  });

  const backup = (messages: number, metadata: Record<string, string>): FakeStream => ({
    config: { name: backupName, subjects: [], metadata } as unknown as StreamConfig,
    messages,
  });

  describe('migrate', () => {
    it('should recreate the stream with the new config and keep every message', async () => {
      // Given
      const streams = new Map([[streamName, original(40)]]);
      const jsm = createFakeJsm(streams);

      // When
      await new StreamMigration(FAST).migrate(jsm, streamName, desired);

      // Then
      expect(streams.get(streamName)).toMatchObject({
        config: { storage: StorageType.Memory, subjects, sources: [] },
        messages: 40,
      });
      expect(streams.has(backupName)).toBe(false);
    });

    it('should take the lock before it stops publishes', async () => {
      // Given
      const jsm = createFakeJsm(new Map([[streamName, original(5)]]));

      // When
      await new StreamMigration(FAST).migrate(jsm, streamName, desired);

      // Then
      const firstAdd = vi.mocked(jsm.streams.add).mock.invocationCallOrder[0]!;
      const quiesce = vi
        .mocked(jsm.streams.update)
        .mock.calls.findIndex(
          ([name, config]) => name === streamName && config.subjects?.length === 0,
        );

      expect(vi.mocked(jsm.streams.add).mock.calls[0]![0].name).toBe(backupName);
      expect(firstAdd).toBeLessThan(
        vi.mocked(jsm.streams.update).mock.invocationCallOrder[quiesce]!,
      );
    });

    it('should mark the backup as the only copy before the new stream exists', async () => {
      // Given
      const streams = new Map([[streamName, original(5)]]);
      const jsm = createFakeJsm(streams);
      let phaseWhenRecreated: string | undefined;

      vi.mocked(jsm.streams.add).mockImplementationOnce(async (config: StreamAddConfig) => {
        streams.set(config.name, { config: structuredClone(config), messages: 0 });

        return createMock<StreamInfo>();
      });
      vi.mocked(jsm.streams.add).mockImplementationOnce(async (config: StreamAddConfig) => {
        phaseWhenRecreated = streams.get(backupName)?.config.metadata?.[MIGRATION_PHASE_KEY];
        streams.set(config.name, { config: structuredClone(config), messages: 0 });

        return createMock<StreamInfo>();
      });

      // When
      await new StreamMigration(FAST).migrate(jsm, streamName, desired);

      // Then
      expect(phaseWhenRecreated).toBe(MigrationPhase.Restore);
    });

    it('should keep its heartbeat going while sourcing is slow', async () => {
      // Given: the copy into the backup takes several heartbeats
      const streams = new Map([[streamName, original(10)]]);
      const startedAt = Date.now();
      const heartbeats = new Set<string>();
      const jsm = createFakeJsm(streams, (name) => {
        const beat = streams.get(backupName)?.config.metadata?.[MIGRATION_HEARTBEAT_KEY];

        if (beat !== undefined) heartbeats.add(beat);

        return name === backupName && Date.now() - startedAt < 150
          ? 10 - Math.floor((Date.now() - startedAt) / 20)
          : 0;
      });

      // When
      await new StreamMigration(FAST).migrate(jsm, streamName, desired);

      // Then
      expect(heartbeats.size).toBeGreaterThan(2);
    });

    it('should apply the config without recreating once a peer has migrated the stream', async () => {
      // Given: a peer holds the lock and finishes while this instance waits
      const streams = new Map([
        [streamName, original(5)],
        [
          backupName,
          backup(0, { [MIGRATION_HEARTBEAT_KEY]: '1', [MIGRATION_PHASE_KEY]: 'backup' }),
        ],
      ]);
      const jsm = createFakeJsm(streams);

      setTimeout(() => {
        streams.set(streamName, {
          ...original(5),
          config: { ...original(5).config, storage: StorageType.Memory },
        });
        streams.delete(backupName);
      }, 60);

      // When
      await new StreamMigration(FAST).migrate(jsm, streamName, desired);

      // Then
      expect(jsm.streams.delete).not.toHaveBeenCalledWith(streamName);
      expect(streams.get(streamName)?.messages).toBe(5);
      expect(streams.has(backupName)).toBe(false);
    });

    it('should fail, roll back and keep the original when sourcing stalls', async () => {
      // Given: the backup never catches up
      const streams = new Map([[streamName, original(10)]]);
      const jsm = createFakeJsm(streams, (name) => (name === backupName ? 7 : 0));

      // When
      const failure = await new StreamMigration(FAST)
        .migrate(jsm, streamName, desired)
        .catch((err: unknown) => err);

      // Then
      expect(failure).toMatchObject({ reason: MigrationErrorReason.SourcingTimeout });
      expect(streams.get(streamName)).toMatchObject({ config: { subjects }, messages: 10 });
      expect(streams.has(backupName)).toBe(false);
    });

    it('should keep waiting while sourcing makes progress, however long it takes', async () => {
      // Given: lag drops by one every 40ms, so the copy outlasts the stall timeout
      const streams = new Map([[streamName, original(10)]]);
      let lag = 10;
      const ticker = setInterval(() => {
        lag = Math.max(0, lag - 1);
      }, 40);
      const jsm = createFakeJsm(streams, (name) => (name === backupName ? lag : 0));

      // When
      await new StreamMigration(FAST).migrate(jsm, streamName, desired);
      clearInterval(ticker);

      // Then
      expect(streams.get(streamName)).toMatchObject({
        config: { storage: StorageType.Memory },
        messages: 10,
      });
    });

    it('should preserve the backup when recreating the stream fails', async () => {
      // Given
      const streams = new Map([[streamName, original(10)]]);
      const jsm = createFakeJsm(streams);
      const fakeAdd = vi.mocked(jsm.streams.add).getMockImplementation()!;

      vi.mocked(jsm.streams.add).mockImplementation(async (config: StreamAddConfig) => {
        if (config.name === streamName) throw new Error('resource limit exceeded');

        return fakeAdd(config);
      });

      // When
      await expect(new StreamMigration(FAST).migrate(jsm, streamName, desired)).rejects.toThrow(
        'resource limit exceeded',
      );

      // Then: the backup is the only copy, marked for the next instance to restore
      expect(streams.get(backupName)).toMatchObject({
        messages: 10,
        config: { metadata: { [MIGRATION_PHASE_KEY]: MigrationPhase.Restore } },
      });
    });

    it('should keep migrating when a single heartbeat fails', async () => {
      // Given: slow sourcing, and the first heartbeat after it starts is rejected
      const streams = new Map([[streamName, original(10)]]);
      const startedAt = Date.now();
      const jsm = createFakeJsm(streams, (name) =>
        name === backupName && Date.now() - startedAt < 120
          ? 5 - Math.floor((Date.now() - startedAt) / 30)
          : 0,
      );
      const fakeUpdate = vi.mocked(jsm.streams.update).getMockImplementation()!;
      let backupUpdates = 0;

      vi.mocked(jsm.streams.update).mockImplementation(async (name, config) => {
        if (name === backupName && ++backupUpdates === 2) throw new Error('heartbeat lost');

        return fakeUpdate(name, config);
      });

      // When
      await new StreamMigration(FAST).migrate(jsm, streamName, desired);

      // Then
      expect(streams.get(streamName)).toMatchObject({ messages: 10 });
      expect(backupUpdates).toBeGreaterThan(2);
    });

    it('should rethrow an unexpected error while taking the lock', async () => {
      // Given
      const jsm = createFakeJsm(new Map([[streamName, original(1)]]));

      vi.mocked(jsm.streams.add).mockRejectedValue(new Error('authorization violation'));

      // When/Then
      await expect(new StreamMigration(FAST).migrate(jsm, streamName, desired)).rejects.toThrow(
        'authorization violation',
      );
      expect(jsm.streams.update).not.toHaveBeenCalled();
    });

    it('should propagate the original error when the rollback itself fails', async () => {
      // Given: deleting the original fails, and so does every later update
      const jsm = createFakeJsm(new Map([[streamName, original(0)]]));
      const fakeUpdate = vi.mocked(jsm.streams.update).getMockImplementation()!;
      let quiesced = false;

      vi.mocked(jsm.streams.delete).mockRejectedValue(new Error('permission denied'));
      vi.mocked(jsm.streams.update).mockImplementation(async (name, config) => {
        if (name === streamName && quiesced) throw new Error('rollback failed');
        if (name === streamName) quiesced = true;

        return fakeUpdate(name, config);
      });

      // When/Then
      await expect(new StreamMigration(FAST).migrate(jsm, streamName, desired)).rejects.toThrow(
        'permission denied',
      );
    });
  });

  describe('settle', () => {
    it('should report nothing to do when no backup exists', async () => {
      // Given
      const jsm = createFakeJsm(new Map([[streamName, original(3)]]));

      // When
      const recovered = await new StreamMigration(FAST).settle(jsm, streamName, desired);

      // Then
      expect(recovered).toBe(false);
    });

    it('should take over a backup left by a release without a heartbeat', async () => {
      // Given: the stream was deleted and the legacy backup holds the only copy
      const streams = new Map([[backupName, backup(8, {})]]);
      const jsm = createFakeJsm(streams);

      // When
      const recovered = await new StreamMigration(FAST).settle(jsm, streamName, desired);

      // Then
      expect(recovered).toBe(true);
      expect(streams.get(streamName)).toMatchObject({ messages: 8, config: { sources: [] } });
      expect(streams.has(backupName)).toBe(false);
    });

    it('should wait for a legacy backup younger than the old grace period', async () => {
      // Given: a backup from a release without a heartbeat, started just now
      const streams = new Map([
        [streamName, original(2)],
        [
          backupName,
          backup(2, { 'nestjs-jetstream-migration-started-at': new Date().toISOString() }),
        ],
      ]);
      const jsm = createFakeJsm(streams);

      setTimeout(() => streams.delete(backupName), 80);

      // When
      const recovered = await new StreamMigration(FAST).settle(jsm, streamName, desired);

      // Then
      expect(recovered).toBe(false);
      expect(jsm.streams.delete).not.toHaveBeenCalled();
    });

    it('should take over a legacy backup whose start time cannot be read', async () => {
      // Given
      const streams = new Map([
        [backupName, backup(0, { 'nestjs-jetstream-migration-started-at': 'not a date' })],
      ]);
      const jsm = createFakeJsm(streams);

      // When
      const recovered = await new StreamMigration(FAST).settle(jsm, streamName, desired);

      // Then: an empty backup only needs the stream recreated
      expect(recovered).toBe(true);
      expect(streams.get(streamName)).toMatchObject({ messages: 0 });
      expect(streams.has(backupName)).toBe(false);
    });

    it('should restore a stale backup that still points at its old source', async () => {
      // Given: the stream was recreated, but the restore never started
      const streams = new Map([
        [streamName, original(0)],
        [
          backupName,
          {
            ...backup(7, {}),
            config: { ...backup(7, {}).config, sources: [{ name: 'gone' }] },
          },
        ],
      ]);
      const jsm = createFakeJsm(streams);

      // When
      await new StreamMigration(FAST).settle(jsm, streamName, desired);

      // Then
      expect(streams.get(streamName)).toMatchObject({ messages: 7, config: { sources: [] } });
      expect(streams.has(backupName)).toBe(false);
    });

    it('should stand down when the backup disappears before it can be claimed', async () => {
      // Given: an abandoned backup that its owner removes at the last moment
      const streams = new Map([
        [streamName, original(3)],
        [backupName, backup(3, {})],
      ]);
      const jsm = createFakeJsm(streams);
      const fakeInfo = vi.mocked(jsm.streams.info).getMockImplementation()!;
      let backupReads = 0;

      vi.mocked(jsm.streams.info).mockImplementation(async (name) => {
        if (name === backupName && ++backupReads === 2) streams.delete(backupName);

        return fakeInfo(name);
      });

      // When
      const recovered = await new StreamMigration(FAST).settle(jsm, streamName, desired);

      // Then
      expect(recovered).toBe(false);
      expect(streams.get(streamName)?.messages).toBe(3);
    });

    it('should finish a restore whose source is still attached', async () => {
      // Given
      const streams = new Map([
        [
          backupName,
          backup(6, { [MIGRATION_HEARTBEAT_KEY]: '4', [MIGRATION_PHASE_KEY]: 'restore' }),
        ],
        [
          streamName,
          {
            config: { ...original(0).config, sources: [{ name: backupName }] },
            messages: 2,
          },
        ],
      ]);
      const jsm = createFakeJsm(streams);

      // When
      await new StreamMigration(FAST).settle(jsm, streamName, desired);

      // Then
      expect(streams.get(streamName)).toMatchObject({ messages: 6, config: { sources: [] } });
      expect(streams.has(backupName)).toBe(false);
    });

    it('should back off when another instance claims the abandoned backup first', async () => {
      // Given: right after this instance claims it, another claim lands on top
      const streams = new Map([
        [streamName, original(4)],
        [
          backupName,
          backup(4, { [MIGRATION_HEARTBEAT_KEY]: '9', [MIGRATION_PHASE_KEY]: 'backup' }),
        ],
      ]);
      const jsm = createFakeJsm(streams);
      const fakeUpdate = vi.mocked(jsm.streams.update).getMockImplementation()!;
      let claimed = false;

      vi.mocked(jsm.streams.update).mockImplementation(async (name, config) => {
        const result = await fakeUpdate(name, config);

        if (name === backupName && !claimed) {
          claimed = true;

          const rival = streams.get(backupName)!;

          rival.config.metadata = {
            ...rival.config.metadata,
            'nestjs-jetstream-migration-owner': 'rival',
          };
          setTimeout(() => streams.delete(backupName), 150);
        }

        return result;
      });

      // When
      const recovered = await new StreamMigration(FAST).settle(jsm, streamName, desired);

      // Then: the rival finished it; this instance touched neither stream
      expect(recovered).toBe(false);
      expect(jsm.streams.delete).not.toHaveBeenCalled();
      expect(streams.get(streamName)?.messages).toBe(4);
    });
  });
});
