import { Logger } from '@nestjs/common';

import {
  RetentionPolicy,
  type JetStreamManager,
  type StreamConfig,
  type StreamInfo,
  type StreamSource,
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
 * Sourcing out of a stream that is not `Limits` acknowledges what it copies, so
 * every message no consumer filter covers moves into the backup instead.
 */
const sourcingMoves = (config: Partial<StreamConfig>): boolean =>
  config.retention !== RetentionPolicy.Limits;

const withoutSource = (sources: StreamSource[] | undefined, name: string): StreamSource[] =>
  (sources ?? []).filter((s) => s.name !== name);

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
  private lastWriteAt = Date.now();
  private lost = false;

  public constructor(
    private readonly jsm: JetStreamManager,
    private readonly backupName: string,
    private readonly timing: MigrationTiming,
    private readonly logger: Logger,
  ) {}

  public start(): void {
    this.timer = setInterval(() => {
      this.update({}).catch((err: unknown) => {
        this.logger.debug(`Migration heartbeat on ${this.backupName} failed`, err);
      });
    }, this.timing.heartbeatIntervalMs);
    this.timer.unref();
  }

  /** Write this owner over whoever holds the backup; only a takeover does this. */
  public claim(): Promise<void> {
    return this.write({}, undefined, true);
  }

  /**
   * Change the backup's config, stamping a fresh heartbeat. Refuses, and
   * loses the lease for good, once another owner's id is on the backup.
   */
  public update(patch: Partial<StreamConfig>, phase?: MigrationPhase): Promise<void> {
    return this.write(patch, phase, false);
  }

  /**
   * Fail unless the lock is still ours. A heartbeat that has not landed for
   * nearly the abandonment window means another instance may already have
   * taken over, so a destructive step must not run.
   */
  public async assertHeld(): Promise<void> {
    await this.queue;
    this.throwIfLost();

    const silentFor = Date.now() - this.lastWriteAt;
    const safeFor = this.timing.abandonedAfterMs - this.timing.heartbeatIntervalMs;
    const { config } = await this.jsm.streams.info(this.backupName);

    if (silentFor < safeFor && config.metadata?.[MIGRATION_OWNER_KEY] === this.owner) return;

    this.markLost();
    this.throwIfLost();
  }

  /** Local check, no round trip: for loops that must not outlive the lease. */
  public throwIfLost(): void {
    if (!this.lost) return;

    throw new JetstreamMigrationError(
      MigrationErrorReason.LockLost,
      `Migration lock on ${this.backupName} is no longer held by this instance; stopping before ` +
        'a destructive step. The instance that holds it finishes the migration.',
    );
  }

  public async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.queue;
  }

  private write(
    patch: Partial<StreamConfig>,
    phase: MigrationPhase | undefined,
    claiming: boolean,
  ): Promise<void> {
    const next = this.queue.then(async () => {
      this.throwIfLost();

      const { config } = await this.jsm.streams.info(this.backupName);

      if (!claiming && config.metadata?.[MIGRATION_OWNER_KEY] !== this.owner) {
        this.markLost();
        this.throwIfLost();
      }

      // Stream updates have no compare-and-set: a claim landing between this read and the write below is overwritten, which takeOver's claim-then-verify detects.
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
      this.lastWriteAt = Date.now();
    });

    this.queue = next.catch(() => undefined);

    return next;
  }

  private markLost(): void {
    if (this.lost) return;

    this.lost = true;
    clearInterval(this.timer);
    this.logger.warn(`Migration lock on ${this.backupName} was taken over by another instance`);
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
 * Sourcing out of a work-queue stream moves the messages no consumer covers,
 * so once Phase 2 has started the backup, not the original, is the copy that
 * counts. An instance that dies mid-migration stops its heartbeat;
 * {@link settle} takes the migration over once the heartbeat has been silent
 * long enough.
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
    let drainedCount = 0;

    try {
      const currentInfo = await jsm.streams.info(streamName);

      if (!compareStreamConfig(currentInfo.config, newConfig).hasImmutableChanges) {
        await this.dropBackup(jsm, backupName, lease);
        this.logger.log(`Stream ${streamName}: migration completed by another instance`);
        await jsm.streams.update(streamName, newConfig);

        return;
      }

      drainedCount = await this.runPhases(jsm, streamName, newConfig, currentInfo, lease);
    } finally {
      await lease.stop();
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

      if (backup === null) {
        await this.detachDanglingSource(jsm, streamName);

        return false;
      }

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
          try {
            await this.finishAbandoned(jsm, streamName, desiredConfig, lease);
          } finally {
            await lease.stop();
          }

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

  /** Whether another instance currently holds the migration lock of the stream. */
  public async isLocked(jsm: JetStreamManager, streamName: string): Promise<boolean> {
    return (await this.tryInfo(jsm, backupNameOf(streamName))) !== null;
  }

  /** Phases 1-4 with the lock held. Returns how many messages were carried over. */
  private async runPhases(
    jsm: JetStreamManager,
    streamName: string,
    newConfig: MigrationStreamConfig,
    currentInfo: StreamInfo,
    lease: MigrationLease,
  ): Promise<number> {
    const backupName = backupNameOf(streamName);
    // The stream may still be quiesced by an earlier attempt; reopen with the
    // subjects it is meant to have, never with none.
    const openConfig = {
      ...currentInfo.config,
      subjects:
        currentInfo.config.subjects.length > 0 ? currentInfo.config.subjects : newConfig.subjects,
      sources: withoutSource(currentInfo.config.sources, backupName),
    };
    let originalDeleted = false;

    this.logger.log(`Stream ${streamName}: destructive migration started`);

    try {
      // Phase 1: Quiesce; an acked publish after this point cannot be lost.
      this.logger.log(`  Phase 1/4: Quiescing ${streamName} (publishes rejected during migration)`);
      await jsm.streams.update(streamName, { ...openConfig, subjects: [] });

      const quiesced = await jsm.streams.info(streamName);
      const drainedCount = quiesced.state.messages;

      this.assertFits(streamName, newConfig, quiesced.state);

      if (drainedCount > 0) {
        // Phase 2: Backup via sourcing
        this.logger.log(`  Phase 2/4: Backing up ${drainedCount} messages -> ${backupName}`);
        await lease.update({ sources: [{ name: streamName }] });
        await this.waitForSourceDrained(jsm, backupName, streamName, drainedCount, true, lease);
      }

      // Phase 3: Delete + recreate. The backup's source names the stream about
      // to be recreated, so it is detached before the new stream exists.
      this.logger.log(`  Phase 3/4: Recreating ${streamName} with the new config`);
      await lease.assertHeld();
      await jsm.streams.delete(streamName);
      originalDeleted = true;
      await lease.update({ sources: [] }, MigrationPhase.Restore);
      await jsm.streams.add(newConfig as StreamConfig);

      if (drainedCount > 0) {
        // Phase 4: Restore from backup
        this.logger.log(`  Phase 4/4: Restoring ${drainedCount} messages from backup`);
        await this.restoreFromBackup(jsm, streamName, newConfig, lease);
      } else {
        await this.dropBackup(jsm, backupName, lease);
      }

      return drainedCount;
    } catch (err) {
      if (originalDeleted) {
        // The backup is the only copy now; another instance or the next startup resumes.
        this.logger.error(
          `Migration of ${streamName} failed after the original was deleted. ` +
            `Backup ${backupName} preserved; restoration resumes on the next startup.`,
        );
      } else {
        await this.rollbackBeforeDelete(jsm, streamName, openConfig, lease);
      }

      throw err;
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
      const lease = new MigrationLease(jsm, backupName, this.timing, this.logger);

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

      lease.start();

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
    const lease = new MigrationLease(jsm, backupName, this.timing, this.logger);

    try {
      await lease.claim();
    } catch (err) {
      if (isNatsError(err, NatsErrorCode.StreamNotFound)) return null;

      throw err;
    }

    await sleep(this.timing.heartbeatIntervalMs);

    const backup = await this.tryInfo(jsm, backupName);

    if (backup?.config.metadata?.[MIGRATION_OWNER_KEY] !== lease.owner) return null;

    lease.start();

    return lease;
  }

  private async finishAbandoned(
    jsm: JetStreamManager,
    streamName: string,
    desiredConfig: MigrationStreamConfig,
    lease: MigrationLease,
  ): Promise<void> {
    const backupName = backupNameOf(streamName);
    const backupInfo = await jsm.streams.info(backupName);
    const phase = backupInfo.config.metadata?.[MIGRATION_PHASE_KEY];
    const streamInfo = await this.tryInfo(jsm, streamName);

    if (streamInfo !== null && phase === MigrationPhase.Backup) {
      // Died before deleting the original. Under a work queue the backup may
      // already hold messages the original no longer has.
      this.logger.warn(`Stream ${streamName}: undoing an abandoned migration`);
      await jsm.streams.update(streamName, {
        ...streamInfo.config,
        subjects: [],
        sources: withoutSource(streamInfo.config.sources, backupName),
      });
      await this.returnBackup(jsm, streamName, streamInfo.config, lease);

      return;
    }

    if (streamInfo === null) {
      // Died between delete and create: the backup holds the only copy. Mark
      // it so before the stream exists, and detach its source, which would
      // otherwise attach to the recreated stream.
      this.logger.warn(`Stream ${streamName}: resuming interrupted migration from ${backupName}`);
      await lease.update({ sources: [] }, MigrationPhase.Restore);
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
      await this.waitForSourceDrained(
        jsm,
        streamName,
        backupName,
        backupInfo.state.messages,
        false,
        lease,
      );
      await this.dropBackup(jsm, backupName, lease);
      await jsm.streams.update(streamName, {
        ...streamInfo.config,
        sources: withoutSource(streamInfo.config.sources, backupName),
      });

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
  }

  /**
   * Put a backup taken in Phase 2 back into the original, which is quiesced.
   * Under `Limits` sourcing only copied, so the original is whole and the
   * backup goes. Otherwise the backup holds whatever sourcing moved out:
   * finish the copy so it holds everything, empty the original, restore.
   */
  private async returnBackup(
    jsm: JetStreamManager,
    streamName: string,
    streamConfig: Partial<StreamConfig>,
    lease: MigrationLease,
  ): Promise<void> {
    const backupName = backupNameOf(streamName);
    const backupInfo = await jsm.streams.info(backupName);

    if (!sourcingMoves(streamConfig) || backupInfo.state.messages === 0) {
      await this.dropBackup(jsm, backupName, lease);

      return;
    }

    await lease.update({ sources: [{ name: streamName }] });
    await this.waitForSourceDrained(jsm, backupName, streamName, 0, true, lease);
    await lease.assertHeld();
    await lease.update({ sources: [] }, MigrationPhase.Restore);
    await jsm.streams.purge(streamName);

    const { config } = await jsm.streams.info(streamName);

    await this.restoreFromBackup(jsm, streamName, { ...config, name: streamName }, lease);
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
    const otherSources = withoutSource(streamConfig.sources, backupName);

    // A stale source ref on the backup would form a sourcing cycle.
    if ((backupInfo.config.sources ?? []).length > 0) {
      await lease.update({ sources: [] }, MigrationPhase.Restore);
    }

    await jsm.streams.update(streamName, {
      ...streamConfig,
      sources: [...otherSources, { name: backupName }],
    });
    await this.waitForSourceDrained(
      jsm,
      streamName,
      backupName,
      backupInfo.state.messages,
      false,
      lease,
    );

    // Backup deleted before the source detaches: the order recovery relies on.
    await this.dropBackup(jsm, backupName, lease);
    await jsm.streams.update(streamName, { ...streamConfig, sources: otherSources });
  }

  private async dropBackup(
    jsm: JetStreamManager,
    backupName: string,
    lease: MigrationLease,
  ): Promise<void> {
    await lease.assertHeld();
    await lease.stop();
    await jsm.streams.delete(backupName);
  }

  /** A crash between dropping the backup and detaching it leaves a source that would attach to the next backup. */
  private async detachDanglingSource(jsm: JetStreamManager, streamName: string): Promise<void> {
    const backupName = backupNameOf(streamName);
    const streamInfo = await this.tryInfo(jsm, streamName);

    if (!streamInfo?.config.sources?.some((s) => s.name === backupName)) return;

    this.logger.warn(`Stream ${streamName}: detaching leftover source ${backupName}`);
    await jsm.streams.update(streamName, {
      ...streamInfo.config,
      sources: withoutSource(streamInfo.config.sources, backupName),
    });
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
   * making progress, so a large stream gets as long as it needs. A growing
   * message count counts as progress only into a stream nobody publishes to.
   */
  private async waitForSourceDrained(
    jsm: JetStreamManager,
    streamName: string,
    sourceName: string,
    minimumMessages: number,
    countsMessages: boolean,
    lease: MigrationLease,
  ): Promise<void> {
    let mostMessages = -1;
    let leastLag = Number.POSITIVE_INFINITY;
    let progressAt = Date.now();

    for (;;) {
      lease.throwIfLost();

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
      const grew = countsMessages && info.state.messages > mostMessages;

      if (grew || lag < leastLag) {
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

  /**
   * Failure before the original was deleted: give back whatever the backup
   * took, then reopen the stream. If that fails too, the stream stays
   * quiesced and the backup stays, so nothing is lost; the next instance
   * to take the lock over finishes the job.
   */
  private async rollbackBeforeDelete(
    jsm: JetStreamManager,
    streamName: string,
    openConfig: Partial<StreamConfig>,
    lease: MigrationLease,
  ): Promise<void> {
    try {
      // A lost lock means another instance owns the backup now; leave both to it.
      await lease.assertHeld();
      await this.returnBackup(jsm, streamName, openConfig, lease);
      await jsm.streams.update(streamName, openConfig);
    } catch (rollbackErr) {
      if (
        rollbackErr instanceof JetstreamMigrationError &&
        rollbackErr.reason === MigrationErrorReason.LockLost
      ) {
        this.logger.warn(
          `Rollback of ${streamName} left to the instance that took the migration over`,
        );

        return;
      }

      this.logger.error(
        `Rollback of ${streamName} after a failed migration also failed; the stream stays ` +
          'quiesced with its backup until another instance takes the migration over:',
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
