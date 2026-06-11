import { Logger } from '@nestjs/common';
import {
  JetStreamApiError,
  type JetStreamManager,
  type StreamConfig,
  type StreamInfo,
} from '@nats-io/jetstream';

import { compareStreamConfig } from './stream-config-diff';
import { NatsErrorCode } from './nats-error-codes';

export const MIGRATION_BACKUP_SUFFIX = '__migration_backup';
const DEFAULT_SOURCING_TIMEOUT_MS = 30_000;
const SOURCING_POLL_INTERVAL_MS = 100;
/** How long migrate() waits for another instance's in-flight migration to finish. */
const DEFAULT_PEER_WAIT_MS = 60_000;
/** Younger backups belong to a live peer migration; older ones get recovered. */
const ACTIVE_MIGRATION_GRACE_MS = 90_000;
const MIGRATION_STARTED_AT_KEY = 'nestjs-jetstream-migration-started-at';

/** Desired stream configuration shape accepted by migration entry points. */
type MigrationStreamConfig = Partial<StreamConfig> & { name: string; subjects: string[] };

/**
 * Orchestrates blue-green stream recreation for immutable property changes.
 *
 * Uses NATS stream sourcing (server-side copy) to preserve messages:
 *   1. Quiesce: drop the original's subjects — publishes reject loudly instead
 *      of being acked into a stream that is about to be deleted
 *   2. Backup: temp stream sources the original; drain tracked via source lag
 *   3. Delete the original, recreate it with the new config
 *   4. Restore: source the backup back, drain, delete the backup BEFORE
 *      detaching the source — so "backup without an attached source" can only
 *      mean the restore never started, which makes recovery re-runnable
 *
 * A process dying mid-migration leaves the backup behind and
 * {@link recoverInterrupted} finishes the job on the next startup; a fresh
 * backup means a live peer migration and is waited out, never deleted.
 *
 * Ref: https://docs.nats.io/nats-concepts/jetstream/streams#sources
 */
export class StreamMigration {
  private readonly logger = new Logger('Jetstream:Stream');

  public constructor(
    private readonly sourcingTimeoutMs = DEFAULT_SOURCING_TIMEOUT_MS,
    private readonly peerWaitMs = DEFAULT_PEER_WAIT_MS,
  ) {}

  public async migrate(
    jsm: JetStreamManager,
    streamName: string,
    newConfig: MigrationStreamConfig,
  ): Promise<void> {
    const backupName = `${streamName}${MIGRATION_BACKUP_SUFFIX}`;
    const startTime = Date.now();

    const peerFinished = await this.waitOutPeerMigration(jsm, backupName);
    const currentInfo = await jsm.streams.info(streamName);

    if (peerFinished && !compareStreamConfig(currentInfo.config, newConfig).hasImmutableChanges) {
      this.logger.log(`Stream ${streamName}: migration completed by another instance`);
      await jsm.streams.update(streamName, newConfig);

      return;
    }

    this.logger.log(`Stream ${streamName}: destructive migration started`);

    let originalDeleted = false;
    let drainedCount = 0;

    try {
      // Phase 1: Quiesce — an acked publish after this point cannot be lost.
      this.logger.log(`  Phase 1/4: Quiescing ${streamName} (publishes rejected during migration)`);
      await jsm.streams.update(streamName, { ...currentInfo.config, subjects: [] });

      drainedCount = (await jsm.streams.info(streamName)).state.messages;

      if (drainedCount > 0) {
        // Phase 2: Backup via sourcing
        this.logger.log(`  Phase 2/4: Backing up ${drainedCount} messages → ${backupName}`);
        await jsm.streams.add({
          ...currentInfo.config,
          name: backupName,
          subjects: [],
          sources: [{ name: streamName }],
          metadata: { [MIGRATION_STARTED_AT_KEY]: new Date().toISOString() },
        } as StreamConfig);

        await this.waitForSourceDrained(jsm, backupName, streamName, drainedCount);
      }

      // Phase 3: Delete + recreate
      this.logger.log(`  Phase 3/4: Recreating ${streamName} with the new config`);
      await jsm.streams.delete(streamName);
      originalDeleted = true;
      await jsm.streams.add(newConfig as StreamConfig);

      if (drainedCount > 0) {
        // Phase 4: Restore from backup
        this.logger.log(`  Phase 4/4: Restoring ${drainedCount} messages from backup`);
        await this.restoreFromBackup(jsm, streamName, newConfig, backupName);
      }
    } catch (err) {
      if (originalDeleted) {
        // The backup is the only copy now; recovery resumes on the next startup.
        this.logger.error(
          `Migration of ${streamName} failed after the original was deleted. ` +
            `Backup ${backupName} preserved — restoration resumes on the next startup.`,
        );
      } else {
        await this.rollbackBeforeDelete(jsm, streamName, currentInfo, backupName);
      }

      throw err;
    }

    const durationMs = Date.now() - startTime;

    this.logger.log(
      `Stream ${streamName}: migration complete (${drainedCount} messages preserved, took ${(durationMs / 1000).toFixed(1)}s)`,
    );
  }

  /**
   * Finish a migration a previous process left unfinished; a backup fresh
   * enough to belong to a live peer migration is left alone.
   */
  public async recoverInterrupted(
    jsm: JetStreamManager,
    streamName: string,
    desiredConfig: MigrationStreamConfig,
  ): Promise<boolean> {
    const backupName = `${streamName}${MIGRATION_BACKUP_SUFFIX}`;
    const backupInfo = await this.tryInfo(jsm, backupName);

    if (backupInfo === null) return false;

    if (this.isPeerMigrationActive(backupInfo)) return false;

    const streamInfo = await this.tryInfo(jsm, streamName);

    if (streamInfo === null) {
      // Died between delete and create: the backup holds the only copy.
      this.logger.warn(`Stream ${streamName}: resuming interrupted migration from ${backupName}`);
      await jsm.streams.add(desiredConfig as StreamConfig);

      if (backupInfo.state.messages > 0) {
        await this.restoreFromBackup(jsm, streamName, desiredConfig, backupName);
      } else {
        await jsm.streams.delete(backupName);
      }

      return true;
    }

    const hasBackupSource = (streamInfo.config.sources ?? []).some((s) => s.name === backupName);

    if (hasBackupSource) {
      // Died mid-restore: the source keeps its position — let it finish.
      this.logger.warn(`Stream ${streamName}: finishing interrupted restore from ${backupName}`);
      await this.waitForSourceDrained(jsm, streamName, backupName, backupInfo.state.messages);
      await jsm.streams.delete(backupName);
      await jsm.streams.update(streamName, { ...streamInfo.config, sources: [] });

      return true;
    }

    if (backupInfo.state.messages === 0) {
      this.logger.warn(`Removing empty migration backup ${backupName}`);
      await jsm.streams.delete(backupName);

      return true;
    }

    // Died before the restore was wired up — nothing sourced yet, so
    // re-running it cannot duplicate messages.
    this.logger.warn(
      `Stream ${streamName}: restoring ${backupInfo.state.messages} messages from stale ${backupName}`,
    );
    await this.restoreFromBackup(
      jsm,
      streamName,
      { ...streamInfo.config, name: streamName, subjects: streamInfo.config.subjects },
      backupName,
    );

    return true;
  }

  /** Attach the backup as a source, drain it fully, then clean up. */
  private async restoreFromBackup(
    jsm: JetStreamManager,
    streamName: string,
    streamConfig: MigrationStreamConfig,
    backupName: string,
  ): Promise<void> {
    // Clear the backup's stale source ref — it would form a sourcing cycle.
    const backupInfo = await jsm.streams.info(backupName);

    if ((backupInfo.config.sources ?? []).length > 0) {
      await jsm.streams.update(backupName, { ...backupInfo.config, sources: [] });
    }

    await jsm.streams.update(streamName, { ...streamConfig, sources: [{ name: backupName }] });
    await this.waitForSourceDrained(jsm, streamName, backupName, backupInfo.state.messages);

    // Backup deleted before the source detaches — the order recovery relies on.
    await jsm.streams.delete(backupName);
    await jsm.streams.update(streamName, { ...streamConfig, sources: [] });
  }

  /**
   * Lag-based drain check — live publishes cannot fake completion. A fresh
   * source reports lag 0 / active -1 before its first sync (NATS 2.12.6),
   * hence the active guard.
   */
  private async waitForSourceDrained(
    jsm: JetStreamManager,
    streamName: string,
    sourceName: string,
    minimumMessages: number,
  ): Promise<void> {
    const deadline = Date.now() + this.sourcingTimeoutMs;

    while (Date.now() < deadline) {
      const info = await jsm.streams.info(streamName);
      const source = (info.sources ?? []).find((s) => s.name === sourceName);

      if (
        source !== undefined &&
        source.active >= 0 &&
        source.lag === 0 &&
        info.state.messages >= minimumMessages
      ) {
        return;
      }

      await new Promise((r) => setTimeout(r, SOURCING_POLL_INTERVAL_MS));
    }

    throw new Error(
      `Stream sourcing timeout: ${sourceName} has not drained into ${streamName} within ` +
        `${this.sourcingTimeoutMs / 1000}s. The backup is preserved; restoration resumes on the next startup.`,
    );
  }

  /**
   * A backup present at migrate() start is a live peer migration — wait it
   * out. Stale leftovers were already handled by recoverInterrupted().
   */
  private async waitOutPeerMigration(jsm: JetStreamManager, backupName: string): Promise<boolean> {
    if ((await this.tryInfo(jsm, backupName)) === null) return false;

    this.logger.warn(
      `Migration backup ${backupName} exists — another instance appears to be migrating; waiting`,
    );

    const deadline = Date.now() + this.peerWaitMs;

    while (Date.now() < deadline) {
      if ((await this.tryInfo(jsm, backupName)) === null) return true;

      await new Promise((r) => setTimeout(r, SOURCING_POLL_INTERVAL_MS * 5));
    }

    throw new Error(
      `Migration backup ${backupName} did not clear within ${this.peerWaitMs / 1000}s. ` +
        'If no other instance is migrating, recover or remove the backup manually.',
    );
  }

  /** Failure before the original was deleted: undo the quiesce, drop our backup. */
  private async rollbackBeforeDelete(
    jsm: JetStreamManager,
    streamName: string,
    originalInfo: StreamInfo,
    backupName: string,
  ): Promise<void> {
    try {
      await jsm.streams.update(streamName, { ...originalInfo.config });

      const backupInfo = await this.tryInfo(jsm, backupName);

      if (backupInfo !== null) {
        await jsm.streams.delete(backupName);
      }
    } catch (rollbackErr) {
      this.logger.error(
        `Rollback of ${streamName} after a failed migration also failed — the stream may be left quiesced:`,
        rollbackErr,
      );
    }
  }

  private isPeerMigrationActive(backupInfo: StreamInfo): boolean {
    const startedAt = backupInfo.config.metadata?.[MIGRATION_STARTED_AT_KEY];

    if (!startedAt) return false;

    const startedMs = Date.parse(startedAt);

    if (Number.isNaN(startedMs)) return false;

    return Date.now() - startedMs < ACTIVE_MIGRATION_GRACE_MS;
  }

  private async tryInfo(jsm: JetStreamManager, name: string): Promise<StreamInfo | null> {
    try {
      return await jsm.streams.info(name);
    } catch (err) {
      if (
        err instanceof JetStreamApiError &&
        err.apiError().err_code === NatsErrorCode.StreamNotFound
      ) {
        return null;
      }

      throw err;
    }
  }
}
