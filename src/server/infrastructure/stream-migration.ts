import { Logger } from '@nestjs/common';
import type { JetStreamManager, StreamConfig } from '@nats-io/jetstream';

const MIGRATION_SUFFIX = '__migration_backup';
const DEFAULT_SOURCING_TIMEOUT_MS = 30_000;
const SOURCING_POLL_INTERVAL_MS = 100;

/**
 * Orchestrates blue-green stream recreation for immutable property changes.
 *
 * Uses NATS stream sourcing (server-side copy) to preserve messages:
 *   1. Backup: create temp stream sourcing from original
 *   2. Delete original
 *   3. Create original with new config
 *   4. Restore: source from temp into new original
 *   5. Cleanup: remove temp stream
 *
 * Ref: https://docs.nats.io/nats-concepts/jetstream/streams#sources
 */
export class StreamMigration {
  private readonly logger = new Logger('Jetstream:Stream');

  public constructor(private readonly sourcingTimeoutMs = DEFAULT_SOURCING_TIMEOUT_MS) {}

  public async migrate(
    jsm: JetStreamManager,
    streamName: string,
    newConfig: Partial<StreamConfig> & { name: string; subjects: string[] },
  ): Promise<void> {
    const backupName = `${streamName}${MIGRATION_SUFFIX}`;
    const startTime = Date.now();

    await this.cleanupOrphanedBackup(jsm, backupName);

    const currentInfo = await jsm.streams.info(streamName);
    const messageCount = currentInfo.state.messages;

    this.logger.log(`Stream ${streamName}: destructive migration started`);

    try {
      if (messageCount > 0) {
        // Phase 1: Backup via sourcing
        this.logger.log(`  Phase 1/4: Backing up ${messageCount} messages → ${backupName}`);
        await jsm.streams.add({
          ...currentInfo.config,
          name: backupName,
          subjects: [],
          sources: [{ name: streamName }],
        } as StreamConfig);

        await this.waitForSourcing(jsm, backupName, messageCount);
      }

      // Phase 2: Delete original
      this.logger.log(`  Phase 2/4: Deleting old stream`);
      await jsm.streams.delete(streamName);

      // Phase 3: Create with new config
      this.logger.log(`  Phase 3/4: Creating stream with new config`);
      await jsm.streams.add(newConfig as StreamConfig);

      if (messageCount > 0) {
        // Phase 4: Restore from backup.
        // First remove the backup's source pointing to streamName — that reference is stale
        // (original was deleted in Phase 2) and would cause a cycle when we make the new
        // stream source from the backup.
        const backupInfo = await jsm.streams.info(backupName);

        await jsm.streams.update(backupName, { ...backupInfo.config, sources: [] });

        this.logger.log(`  Phase 4/4: Restoring ${messageCount} messages from backup`);
        await jsm.streams.update(streamName, {
          ...newConfig,
          sources: [{ name: backupName }],
        });

        await this.waitForSourcing(jsm, streamName, messageCount);

        // Remove sources — pass full config without sources
        await jsm.streams.update(streamName, { ...newConfig, sources: [] });
        await jsm.streams.delete(backupName);
      }
    } catch (err) {
      // Cleanup backup on any failure during migration
      await this.cleanupOrphanedBackup(jsm, backupName);
      throw err;
    }

    const durationMs = Date.now() - startTime;

    this.logger.log(
      `Stream ${streamName}: migration complete (${messageCount} messages preserved, took ${(durationMs / 1000).toFixed(1)}s)`,
    );
  }

  private async waitForSourcing(
    jsm: JetStreamManager,
    streamName: string,
    expectedCount: number,
  ): Promise<void> {
    const deadline = Date.now() + this.sourcingTimeoutMs;

    while (Date.now() < deadline) {
      const info = await jsm.streams.info(streamName);

      if (info.state.messages >= expectedCount) return;

      await new Promise((r) => setTimeout(r, SOURCING_POLL_INTERVAL_MS));
    }

    throw new Error(
      `Stream sourcing timeout: ${streamName} has not reached ${expectedCount} messages within ${this.sourcingTimeoutMs / 1000}s`,
    );
  }

  private async cleanupOrphanedBackup(jsm: JetStreamManager, backupName: string): Promise<void> {
    try {
      await jsm.streams.info(backupName);
      this.logger.warn(`Found orphaned migration backup stream: ${backupName}, cleaning up`);
      await jsm.streams.delete(backupName);
    } catch {
      // Backup doesn't exist — expected path
    }
  }
}
