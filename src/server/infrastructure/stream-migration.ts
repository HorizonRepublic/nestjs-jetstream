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
/**
 * Backups younger than this are treated as another instance's live migration
 * and never touched. Stale ones (older, or without the metadata stamp) are
 * leftovers of an interrupted run and get recovered.
 */
const ACTIVE_MIGRATION_GRACE_MS = 90_000;
const MIGRATION_STARTED_AT_KEY = 'nestjs-jetstream-migration-started-at';

/** Desired stream configuration shape accepted by migration entry points. */
type MigrationStreamConfig = Partial<StreamConfig> & { name: string; subjects: string[] };

/**
 * Orchestrates blue-green stream recreation for immutable property changes.
 *
 * Uses NATS stream sourcing (server-side copy) to preserve messages:
 *   1. Quiesce: remove the original's subjects so new publishes are rejected
 *      loudly instead of acked into a stream that is about to be deleted
 *   2. Backup: create temp stream sourcing from the original; wait for the
 *      source lag to reach zero (immune to message-count races)
 *   3. Delete original
 *   4. Create original with the new config
 *   5. Restore: source from the backup into the new original, drain, then
 *      delete the backup BEFORE detaching the source — the surviving order
 *      guarantees "backup exists with no source attached" can only mean the
 *      restore never started, which {@link recoverInterrupted} re-runs safely
 *
 * Publishers see "no stream matches subject" errors from quiesce until
 * Phase 4 completes. Client-side retry is the caller's responsibility — the
 * alternative was acknowledged writes that silently vanished.
 *
 * A process dying mid-migration leaves the backup behind;
 * {@link recoverInterrupted} finishes the job on the next startup. Backups
 * created moments ago belong to another instance's live migration (rolling
 * deploys) and are waited out, never deleted.
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
      // Phase 1: Quiesce — without this, a publish acked between the backup
      // catching up and the delete would be destroyed with the stream.
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
        // The backup is the only copy now — recoverInterrupted() resumes the
        // restore on the next startup.
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
   * Detect and finish a migration that a previous process left unfinished.
   * Safe against concurrent instances: a backup fresh enough to belong to a
   * live migration is left alone.
   *
   * @returns true when recovery work was performed.
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
      // Died mid-restore: the source keeps its position server-side — let it
      // finish, then clean up.
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

    // Died after the recreate but before the restore was wired up. Nothing
    // from the backup has been sourced yet (sources are only detached after a
    // full drain), so re-running the restore cannot duplicate messages.
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
    // The backup's own source still points at the (recreated) original —
    // stale, and a cycle once the original sources from the backup.
    const backupInfo = await jsm.streams.info(backupName);

    if ((backupInfo.config.sources ?? []).length > 0) {
      await jsm.streams.update(backupName, { ...backupInfo.config, sources: [] });
    }

    await jsm.streams.update(streamName, { ...streamConfig, sources: [{ name: backupName }] });
    await this.waitForSourceDrained(jsm, streamName, backupName, backupInfo.state.messages);

    // Delete the backup before detaching the source — see the class doc for
    // why this order is what makes recoverInterrupted() safe.
    await jsm.streams.delete(backupName);
    await jsm.streams.update(streamName, { ...streamConfig, sources: [] });
  }

  /**
   * Wait until `sourceName` is fully drained into `streamName`. Lag-based, so
   * concurrent live publishes to the target cannot fake completion the way a
   * bare message-count comparison could. A freshly attached source reports
   * `lag: 0, active: -1` before its first sync — `active >= 0` filters that
   * false positive out (verified against NATS 2.12.6).
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
   * A backup already present when migrate() begins belongs to another
   * instance migrating right now (rolling deploy) — wait for it to finish.
   * Stale leftovers are handled by recoverInterrupted() before migrate() runs,
   * so a timeout here means something is genuinely stuck.
   *
   * @returns true when a peer's backup was observed and cleared.
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
