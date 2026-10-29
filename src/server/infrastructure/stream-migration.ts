import { Logger } from '@nestjs/common';

import {
  type JetStreamManager,
  type StreamConfig,
  type StreamInfo,
  type StreamState,
} from '@nats-io/jetstream';
import { nuid } from '@nats-io/nuid';

import { JetstreamMigrationError, MigrationErrorReason } from '../../errors';
import { isNatsError, NatsErrorCode } from './nats-error-codes';
import { compareStreamConfig } from './stream-config-diff';
import { MigrationPhase, type MigrationTiming } from './stream-migration.types';

export const MIGRATION_BACKUP_SUFFIX = '__migration_backup';

export const MIGRATION_HEARTBEAT_KEY = 'nestjs-jetstream-migration-heartbeat';

export const MIGRATION_PHASE_KEY = 'nestjs-jetstream-migration-phase';

const MIGRATION_OWNER_KEY = 'nestjs-jetstream-migration-owner';
const MIGRATION_STARTED_AT_KEY = 'nestjs-jetstream-migration-started-at';

const DEFAULT_TIMING: MigrationTiming = {
  heartbeatIntervalMs: 5_000,
  abandonedAfterMs: 30_000,
  stallTimeoutMs: 30_000,
};
const SOURCING_POLL_INTERVAL_MS = 100;
/** Backups written before the heartbeat existed: younger ones belong to a live migration. */
const LEGACY_ACTIVE_GRACE_MS = 90_000;

/** Desired stream configuration shape accepted by migration entry points. */
type MigrationStreamConfig = Partial<StreamConfig> & { name: string; subjects: string[] };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const backupNameOf = (streamName: string): string => `${streamName}${MIGRATION_BACKUP_SUFFIX}`;

/**
 * The migration lock: whoever holds the backup stream owns the migration. A
 * heartbeat in its metadata tells other instances the owner is alive. Every
 * change to the backup's config goes through this lease, so a heartbeat never
 * writes back a config read before another change.
 */
class MigrationLease {
  public readonly owner = nuid.next();
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private beats = 0;

  public constructor(
    private readonly jsm: JetStreamManager,
    private readonly backupName: string,
    private readonly logger: Logger,
  ) {}

  public start(intervalMs: number): void {
    this.timer = setInterval(() => {
      this.update({}).catch((err: unknown) => {
        this.logger.debug(`Migration heartbeat on ${this.backupName} failed`, err);
      });
    }, intervalMs);
    this.timer.unref();
  }

  /** Change the backup's config, stamping this owner and a fresh heartbeat. */
  public update(patch: Partial<StreamConfig>, phase?: MigrationPhase): Promise<void> {
    const next = this.queue.then(async () => {
      const { config } = await this.jsm.streams.info(this.backupName);

      this.beats += 1;
      await this.jsm.streams.update(this.backupName, {
        ...config,
        ...patch,
        metadata: {
          ...config.metadata,
          ...(phase === undefined ? {} : { [MIGRATION_PHASE_KEY]: phase }),
          [MIGRATION_OWNER_KEY]: this.owner,
          [MIGRATION_HEARTBEAT_KEY]: String(this.beats),
        },
      });
    });

    this.queue = next.catch(() => undefined);

    return next;
  }

  public async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.queue;
  }
}

/**
 * Orchestrates blue-green stream recreation for immutable property changes.
 *
 * Uses NATS stream sourcing (server-side copy) to preserve messages:
 *   0. Lock: create the backup stream; only one instance can, the rest wait
 *   1. Quiesce: drop the original's subjects, so publishes reject loudly instead
 *      of being acked into a stream that is about to be deleted
 *   2. Backup: the backup sources the original; drain tracked via source lag
 *   3. Delete the original, mark the backup as the only copy, recreate the stream
 *   4. Restore: source the backup back, drain, delete the backup BEFORE
 *      detaching the source, so "backup without an attached source" can only
 *      mean the restore never started, which makes recovery re-runnable
 *
 * An instance that dies mid-migration stops its heartbeat; {@link settle}
 * takes the migration over once the heartbeat has been silent long enough.
 *
 * Ref: https://docs.nats.io/nats-concepts/jetstream/streams#sources
 */
export class StreamMigration {
  private readonly logger = new Logger('Jetstream:Stream');
  private readonly timing: MigrationTiming;

  public constructor(timing: Partial<MigrationTiming> = {}) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  public async migrate(
    jsm: JetStreamManager,
    streamName: string,
    newConfig: MigrationStreamConfig,
  ): Promise<void> {
    const backupName = backupNameOf(streamName);
    const startTime = Date.now();
    const lease = await this.acquire(jsm, streamName, newConfig);
    const currentInfo = await jsm.streams.info(streamName);

    if (!compareStreamConfig(currentInfo.config, newConfig).hasImmutableChanges) {
      await lease.stop();
      await jsm.streams.delete(backupName);
      this.logger.log(`Stream ${streamName}: migration completed by another instance`);
      await jsm.streams.update(streamName, newConfig);

      return;
    }

    this.logger.log(`Stream ${streamName}: destructive migration started`);

    let originalDeleted = false;
    let drainedCount = 0;

    try {
      // Phase 1: Quiesce; an acked publish after this point cannot be lost.
      this.logger.log(`  Phase 1/4: Quiescing ${streamName} (publishes rejected during migration)`);
      await jsm.streams.update(streamName, { ...currentInfo.config, subjects: [] });

      const quiesced = await jsm.streams.info(streamName);

      drainedCount = quiesced.state.messages;
      this.assertFits(streamName, newConfig, quiesced.state);

      if (drainedCount > 0) {
        // Phase 2: Backup via sourcing
        this.logger.log(`  Phase 2/4: Backing up ${drainedCount} messages -> ${backupName}`);
        await lease.update({ sources: [{ name: streamName }] });
        await this.waitForSourceDrained(jsm, backupName, streamName, drainedCount);
      }

      // Phase 3: Delete + recreate. The backup's source names the stream about
      // to be recreated, so it is detached before the new stream exists.
      this.logger.log(`  Phase 3/4: Recreating ${streamName} with the new config`);
      await jsm.streams.delete(streamName);
      originalDeleted = true;
      await lease.update({ sources: [] }, MigrationPhase.Restore);
      await jsm.streams.add(newConfig as StreamConfig);

      if (drainedCount > 0) {
        // Phase 4: Restore from backup
        this.logger.log(`  Phase 4/4: Restoring ${drainedCount} messages from backup`);
        await this.restoreFromBackup(jsm, streamName, newConfig, lease);
      } else {
        await lease.stop();
        await jsm.streams.delete(backupName);
      }
    } catch (err) {
      await lease.stop();

      if (originalDeleted) {
        // The backup is the only copy now; another instance or the next startup resumes.
        this.logger.error(
          `Migration of ${streamName} failed after the original was deleted. ` +
            `Backup ${backupName} preserved; restoration resumes on the next startup.`,
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
   * Wait until no migration of the stream is in flight: a live one is waited
   * out, an abandoned one is taken over and finished.
   *
   * @returns Whether this instance finished an abandoned migration.
   */
  public async settle(
    jsm: JetStreamManager,
    streamName: string,
    desiredConfig: MigrationStreamConfig,
  ): Promise<boolean> {
    const backupName = backupNameOf(streamName);
    const pollMs = Math.min(1_000, this.timing.heartbeatIntervalMs);
    let observed: string | undefined;
    let observedAt = Date.now();
    let announced = false;

    for (;;) {
      const backup = await this.tryInfo(jsm, backupName);

      if (backup === null) return false;

      const metadata = backup.config.metadata ?? {};
      const heartbeat = metadata[MIGRATION_HEARTBEAT_KEY];
      let abandoned: boolean;

      if (heartbeat === undefined) {
        abandoned = !this.isLegacyMigrationActive(backup);
      } else {
        const pulse = `${metadata[MIGRATION_OWNER_KEY]}:${heartbeat}`;

        if (pulse !== observed) {
          observed = pulse;
          observedAt = Date.now();
        }

        abandoned = Date.now() - observedAt >= this.timing.abandonedAfterMs;
      }

      if (abandoned) {
        const lease = await this.takeOver(jsm, backupName);

        if (lease !== null) {
          await this.finishAbandoned(jsm, streamName, desiredConfig, lease);

          return true;
        }

        observed = undefined;
      } else if (!announced) {
        this.logger.warn(`Stream ${streamName}: another instance is migrating it; waiting`);
        announced = true;
      }

      await sleep(pollMs);
    }
  }

  /** Take the lock by creating the backup; wait for any other holder first. */
  private async acquire(
    jsm: JetStreamManager,
    streamName: string,
    desiredConfig: MigrationStreamConfig,
  ): Promise<MigrationLease> {
    const backupName = backupNameOf(streamName);

    for (;;) {
      const { config } = await jsm.streams.info(streamName);
      const lease = new MigrationLease(jsm, backupName, this.logger);

      try {
        // The owner id keeps two configs from ever matching, so a second
        // create fails instead of succeeding as an idempotent no-op.
        await jsm.streams.add({
          ...config,
          name: backupName,
          subjects: [],
          sources: [],
          metadata: {
            [MIGRATION_STARTED_AT_KEY]: new Date().toISOString(),
            [MIGRATION_OWNER_KEY]: lease.owner,
            [MIGRATION_PHASE_KEY]: MigrationPhase.Backup,
            [MIGRATION_HEARTBEAT_KEY]: '0',
          },
        } as StreamConfig);
      } catch (err) {
        if (!isNatsError(err, NatsErrorCode.StreamAlreadyExists)) throw err;

        await this.settle(jsm, streamName, desiredConfig);
        continue;
      }

      lease.start(this.timing.heartbeatIntervalMs);

      return lease;
    }
  }

  /**
   * Claim an abandoned backup. Two instances may decide at once, so each
   * writes its owner id, waits a heartbeat, and only the one whose id stuck
   * proceeds; the write also restarts every other observer's silence timer.
   */
  private async takeOver(
    jsm: JetStreamManager,
    backupName: string,
  ): Promise<MigrationLease | null> {
    const lease = new MigrationLease(jsm, backupName, this.logger);

    try {
      await lease.update({});
    } catch (err) {
      if (isNatsError(err, NatsErrorCode.StreamNotFound)) return null;

      throw err;
    }

    await sleep(this.timing.heartbeatIntervalMs);

    const backup = await this.tryInfo(jsm, backupName);

    if (backup?.config.metadata?.[MIGRATION_OWNER_KEY] !== lease.owner) return null;

    lease.start(this.timing.heartbeatIntervalMs);

    return lease;
  }

  private async finishAbandoned(
    jsm: JetStreamManager,
    streamName: string,
    desiredConfig: MigrationStreamConfig,
    lease: MigrationLease,
  ): Promise<void> {
    const backupName = backupNameOf(streamName);

    try {
      const backupInfo = await jsm.streams.info(backupName);
      const phase = backupInfo.config.metadata?.[MIGRATION_PHASE_KEY];
      const streamInfo = await this.tryInfo(jsm, streamName);

      if (streamInfo !== null && phase === MigrationPhase.Backup) {
        // Died before deleting the original: it still holds every message.
        this.logger.warn(`Stream ${streamName}: dropping ${backupName} of an abandoned migration`);
        await this.dropBackup(jsm, backupName, lease);

        return;
      }

      if (streamInfo === null) {
        // Died between delete and create: the backup holds the only copy.
        this.logger.warn(`Stream ${streamName}: resuming interrupted migration from ${backupName}`);
        await jsm.streams.add(desiredConfig as StreamConfig);

        if (backupInfo.state.messages > 0) {
          await this.restoreFromBackup(jsm, streamName, desiredConfig, lease);
        } else {
          await this.dropBackup(jsm, backupName, lease);
        }

        return;
      }

      const hasBackupSource = (streamInfo.config.sources ?? []).some((s) => s.name === backupName);

      if (hasBackupSource) {
        // Died mid-restore: the source keeps its position, let it finish.
        this.logger.warn(`Stream ${streamName}: finishing interrupted restore from ${backupName}`);
        await this.waitForSourceDrained(jsm, streamName, backupName, backupInfo.state.messages);
        await this.dropBackup(jsm, backupName, lease);
        await jsm.streams.update(streamName, { ...streamInfo.config, sources: [] });

        return;
      }

      if (backupInfo.state.messages === 0) {
        this.logger.warn(`Removing empty migration backup ${backupName}`);
        await this.dropBackup(jsm, backupName, lease);

        return;
      }

      // Died before the restore was wired up: nothing sourced yet, so
      // re-running it cannot duplicate messages.
      this.logger.warn(
        `Stream ${streamName}: restoring ${backupInfo.state.messages} messages from stale ${backupName}`,
      );
      await this.restoreFromBackup(
        jsm,
        streamName,
        { ...streamInfo.config, name: streamName, subjects: streamInfo.config.subjects },
        lease,
      );
    } finally {
      await lease.stop();
    }
  }

  /** Attach the backup as a source, drain it fully, then clean up. */
  private async restoreFromBackup(
    jsm: JetStreamManager,
    streamName: string,
    streamConfig: MigrationStreamConfig,
    lease: MigrationLease,
  ): Promise<void> {
    const backupName = backupNameOf(streamName);
    const backupInfo = await jsm.streams.info(backupName);

    // A stale source ref on the backup would form a sourcing cycle.
    if ((backupInfo.config.sources ?? []).length > 0) {
      await lease.update({ sources: [] }, MigrationPhase.Restore);
    }

    await jsm.streams.update(streamName, { ...streamConfig, sources: [{ name: backupName }] });
    await this.waitForSourceDrained(jsm, streamName, backupName, backupInfo.state.messages);

    // Backup deleted before the source detaches: the order recovery relies on.
    await this.dropBackup(jsm, backupName, lease);
    await jsm.streams.update(streamName, { ...streamConfig, sources: [] });
  }

  private async dropBackup(
    jsm: JetStreamManager,
    backupName: string,
    lease: MigrationLease,
  ): Promise<void> {
    await lease.stop();
    await jsm.streams.delete(backupName);
  }

  /** Refuse to recreate a stream whose new limits would evict or reject what it holds. */
  private assertFits(streamName: string, config: MigrationStreamConfig, state: StreamState): void {
    const maxMsgs = config.max_msgs ?? -1;
    const maxBytes = config.max_bytes ?? -1;
    const tooMany = maxMsgs > 0 && state.messages > maxMsgs;
    const tooBig = maxBytes > 0 && state.bytes > maxBytes;

    if (!tooMany && !tooBig) return;

    throw new JetstreamMigrationError(
      MigrationErrorReason.InsufficientCapacity,
      `Stream ${streamName} holds ${state.messages} messages (${state.bytes} bytes), more than the ` +
        `new config allows (max_msgs ${maxMsgs}, max_bytes ${maxBytes}). Raise the limits, or let ` +
        'consumers drain the stream, before migrating.',
    );
  }

  /**
   * Lag-based drain check: live publishes cannot fake completion. A fresh
   * source reports lag 0 / active -1 before its first sync (NATS 2.12.6), so
   * the active guard covers that window. It fails only once sourcing stops
   * making progress, so a large stream gets as long as it needs.
   */
  private async waitForSourceDrained(
    jsm: JetStreamManager,
    streamName: string,
    sourceName: string,
    minimumMessages: number,
  ): Promise<void> {
    let mostMessages = -1;
    let leastLag = Number.POSITIVE_INFINITY;
    let progressAt = Date.now();

    for (;;) {
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

      const lag = source?.lag ?? Number.POSITIVE_INFINITY;

      if (info.state.messages > mostMessages || lag < leastLag) {
        mostMessages = Math.max(mostMessages, info.state.messages);
        leastLag = Math.min(leastLag, lag);
        progressAt = Date.now();
      } else if (Date.now() - progressAt >= this.timing.stallTimeoutMs) {
        throw new JetstreamMigrationError(
          MigrationErrorReason.SourcingTimeout,
          `Stream sourcing stalled: ${sourceName} made no progress into ${streamName} for ` +
            `${this.timing.stallTimeoutMs / 1000}s.`,
        );
      }

      await sleep(SOURCING_POLL_INTERVAL_MS);
    }
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
      await jsm.streams.delete(backupName);
    } catch (rollbackErr) {
      this.logger.error(
        `Rollback of ${streamName} after a failed migration also failed; the stream may be left quiesced:`,
        rollbackErr,
      );
    }
  }

  private isLegacyMigrationActive(backupInfo: StreamInfo): boolean {
    const startedAt = backupInfo.config.metadata?.[MIGRATION_STARTED_AT_KEY];

    if (!startedAt) return false;

    const startedMs = Date.parse(startedAt);

    if (Number.isNaN(startedMs)) return false;

    return Date.now() - startedMs < LEGACY_ACTIVE_GRACE_MS;
  }

  private async tryInfo(jsm: JetStreamManager, name: string): Promise<StreamInfo | null> {
    try {
      return await jsm.streams.info(name);
    } catch (err) {
      if (isNatsError(err, NatsErrorCode.StreamNotFound)) {
        return null;
      }

      throw err;
    }
  }
}
