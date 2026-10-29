import { Logger } from '@nestjs/common';

import {
  RetentionPolicy,
  StorageType,
  type StreamConfig,
  type StreamInfo,
} from '@nats-io/jetstream';

import { ConnectionProvider } from '../../connection';
import { NatsCapability } from '../../connection/server-capabilities.types';
import type { CapabilityUsage } from '../../connection/server-capabilities.types';
import { JetstreamMigrationError, MigrationErrorReason } from '../../errors';
import { ManagementMode, StreamKind } from '../../interfaces';
import type { JetstreamModuleOptions } from '../../interfaces';
import {
  DEFAULT_BROADCAST_STREAM_CONFIG,
  DEFAULT_COMMAND_STREAM_CONFIG,
  DEFAULT_EVENT_STREAM_CONFIG,
  DEFAULT_ORDERED_STREAM_CONFIG,
  DEFAULT_SCHEDULE_STREAM_CONFIG,
  DEFAULT_DLQ_STREAM_CONFIG,
} from '../../jetstream.constants';
import {
  deriveOtelAttrs,
  withMigrationSpan,
  withProvisioningSpan,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../../otel';
import { isDlqEnabled, dlqStreamOverrides } from './dlq-options';
import { InfrastructureBinder } from './infrastructure-binder';
import { kindOptionsBlock, resolveManagementMode } from './management';
import { NameResolver } from './name-resolver';
import { isNatsError, NatsErrorCode } from './nats-error-codes';
import { assertStorageBudget } from './provisioning-budget';
import { runProvisioningOp, type ProvisioningErrorContext } from './provisioning-error';
import {
  formatProvisioningSummary,
  type ExternalBinding,
  type ReservationKind,
  type StreamReservation,
} from './provisioning-summary';
import { compareStreamConfig, type StreamConfigDiffResult } from './stream-config-diff';
import { StreamMigration } from './stream-migration';
import { mergeOwnedMetadata, StreamOwnership } from './stream-ownership';
import { subjectCovers } from './subject-utils';

/**
 * Manages JetStream stream lifecycle: creation, updates, and idempotent ensures.
 *
 * Creates up to three stream types depending on configuration:
 * - **Event stream**: workqueue events (always, when consumer enabled)
 * - **Command stream**: RPC commands (only in jetstream RPC mode)
 * - **Broadcast stream**: fan-out events (only if broadcast handlers exist)
 *
 * All operations are idempotent: safe to call on every startup and reconnection.
 */
export class StreamProvider {
  private readonly logger = new Logger('Jetstream:Stream');
  private readonly migration = new StreamMigration();
  private readonly ownership: StreamOwnership;

  private readonly otel: ResolvedOtelOptions;
  private readonly otelServiceName: string;
  private readonly otelEndpoint: ServerEndpoint | null;

  public constructor(
    private readonly options: JetstreamModuleOptions,
    private readonly connection: ConnectionProvider,
    private readonly names: NameResolver,
    private readonly binder: InfrastructureBinder,
  ) {
    const derived = deriveOtelAttrs(options);

    this.otel = derived.otel;
    this.otelServiceName = derived.serviceName;
    this.otelEndpoint = derived.serverEndpoint;
    this.ownership = new StreamOwnership(options);
  }

  /**
   * Ensure all required streams exist with correct configuration.
   *
   * @param kinds Which stream kinds to create. Determined by the module based
   *              on RPC mode and registered handler patterns.
   * If the dlq option is enabled, also ensures the DLQ stream exists.
   */
  public async ensureStreams(kinds: StreamKind[]): Promise<void> {
    const jsm = await this.connection.getJetStreamManager();

    const { autoKinds, externalKinds } = this.partitionByManagement(kinds);

    const reservations = autoKinds.map((kind) =>
      this.buildReservation(kind, this.buildConfig(kind)),
    );
    const external: ExternalBinding[] = externalKinds.map((kind) => ({
      kind,
      name: this.names.streamName(kind),
    }));

    const dlqEnabled = isDlqEnabled(this.options);
    const dlqIsManual =
      dlqEnabled && resolveManagementMode(this.options, 'dlq', 'stream') === ManagementMode.Manual;

    if (dlqEnabled) {
      if (dlqIsManual) {
        external.push({ kind: 'dlq', name: this.names.dlqStreamName() });
      } else {
        reservations.push(this.buildReservation('dlq', this.buildDlqConfig()));
      }
    }

    this.logger.log(`\n${formatProvisioningSummary(this.options.name, reservations, external)}`);

    await this.assertServerSupports(kinds);

    if (this.options.provisioning?.preflightStorageCheck && reservations.length > 0) {
      await assertStorageBudget(jsm, this.options.name, reservations, this.logger);
    }

    await Promise.all([
      ...autoKinds.map((kind) => this.ensureStream(jsm, kind)),
      ...externalKinds.map((kind) => this.bindStream(jsm, kind)),
    ]);

    if (dlqEnabled) {
      if (dlqIsManual) {
        await this.bindDlqStream(jsm);
      } else {
        await this.ensureDlqStream(jsm);
      }
    }
  }

  /**
   * Refuse stream features the server would silently drop: NATS before 2.11
   * accepts `allow_msg_ttl` and ignores it, and before 2.12 does the same with
   * `allow_msg_schedules`, so the stream would look fine and never expire or fire.
   */
  private async assertServerSupports(kinds: StreamKind[]): Promise<void> {
    const gated: CapabilityUsage[] = [];

    for (const kind of kinds) {
      const config = { ...this.getDefaults(kind), ...this.getOverrides(kind) };
      const stream = this.getStreamName(kind);

      if (config.allow_msg_ttl === true) {
        gated.push({
          capability: NatsCapability.MessageTtl,
          usage: `Stream ${stream} (allow_msg_ttl)`,
        });
      }

      if (config.allow_msg_schedules === true) {
        gated.push({
          capability: NatsCapability.MessageSchedules,
          usage: `Stream ${stream} (allow_msg_schedules)`,
        });
      }
    }

    if (gated.length === 0) return;

    const capabilities = await this.connection.getCapabilities();

    for (const { capability, usage } of gated) capabilities.assert(capability, usage);
  }

  /** Get the stream name for a given kind. */
  public getStreamName(kind: StreamKind): string {
    return this.names.streamName(kind);
  }

  /** Get the subjects pattern for a given kind. */
  public getSubjects(kind: StreamKind): string[] {
    const filter = this.names.filterSubject(kind);
    // Holders need their own subject unless the kind's wildcard already covers them.
    const holdsSchedules =
      kind === StreamKind.Schedule || (kind === StreamKind.Event && this.isSchedulingEnabled(kind));
    const dedicatedSchedule = holdsSchedules && !this.names.hasCustomPrefix(kind);

    return dedicatedSchedule ? [filter, `${this.names.schedulePrefix(kind)}>`] : [filter];
  }

  /** Ensure a single stream exists, creating or updating as needed. */
  private async ensureStream(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: StreamKind,
  ): Promise<StreamInfo> {
    return this.ensureStreamConfig(jsm, kind, this.buildConfig(kind));
  }

  /** Ensure a dead-letter queue stream exists, creating or updating as needed. */
  private async ensureDlqStream(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
  ): Promise<StreamInfo> {
    return this.ensureStreamConfig(jsm, 'dlq', this.buildDlqConfig());
  }

  private async ensureStreamConfig(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: ReservationKind,
    config: Partial<StreamConfig> & { name: string; subjects: string[] },
  ): Promise<StreamInfo> {
    const ctx = this.errorContext(kind, config);
    const label = kind === 'dlq' ? 'DLQ stream' : 'stream';

    return withProvisioningSpan(
      this.otel,
      {
        serviceName: this.otelServiceName,
        endpoint: this.otelEndpoint,
        entity: 'stream',
        name: config.name,
        action: 'ensure',
        maxBytes: ctx.maxBytes,
        numReplicas: ctx.numReplicas,
        reservation:
          ctx.maxBytes !== undefined && ctx.numReplicas !== undefined
            ? ctx.maxBytes * ctx.numReplicas
            : undefined,
      },
      async () => {
        this.logger.log(`Ensuring ${label}: ${config.name}`);

        // Finish any migration a previous process left unfinished.
        if (kind !== 'dlq') {
          await this.migration.recoverInterrupted(jsm, config.name, config);
        }

        try {
          const currentInfo = await jsm.streams.info(config.name);

          return await this.handleExistingStream(jsm, currentInfo, config, ctx);
        } catch (err) {
          if (isNatsError(err, NatsErrorCode.StreamNotFound)) {
            this.logger.log(`Creating ${label}: ${config.name}`);

            try {
              return await runProvisioningOp(ctx, () => jsm.streams.add(config as StreamConfig));
            } catch (createErr) {
              // Two connections of one service racing to create the same stream
              // both saw "not found"; the loser lands here. Re-read the stream so
              // the ownership check can report which connections collided instead
              // of a bare "name already in use".
              await this.ownership.rethrowAsConflict(jsm, config, createErr);
              throw createErr;
            }
          }

          throw err;
        }
      },
    );
  }

  private async handleExistingStream(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    currentInfo: StreamInfo,
    config: Partial<StreamConfig> & { name: string; subjects: string[] },
    ctx: ProvisioningErrorContext,
  ): Promise<StreamInfo> {
    if (this.isSharedStream(config.name)) {
      const merged = [...new Set([...config.subjects, ...currentInfo.config.subjects])];

      config.subjects = merged.filter((s) => !merged.some((other) => subjectCovers(other, s)));
    }

    this.ownership.assertOwnership(currentInfo, config);

    // Preserve metadata the transport did not author, such as migration markers
    // or operator-set keys. An update replaces the whole config, so omitting the
    // field would drop them — merge even when the transport contributes nothing.
    const mergedMetadata = { ...currentInfo.config.metadata, ...config.metadata };

    if (Object.keys(mergedMetadata).length > 0) {
      config.metadata = mergedMetadata;
    }

    const diff = compareStreamConfig(currentInfo.config, config);

    if (!diff.hasChanges) {
      this.logger.debug(`Stream ${config.name}: no config changes`);
      return currentInfo;
    }

    this.logChanges(config.name, diff, !!this.options.provisioning?.allowDestructiveMigration);

    if (diff.hasTransportControlledConflicts) {
      const conflicts = diff.changes
        .filter((c) => c.mutability === 'transport-controlled')
        .map((c) => `${c.property}: ${JSON.stringify(c.current)} -> ${JSON.stringify(c.desired)}`)
        .join(', ');

      throw new JetstreamMigrationError(
        MigrationErrorReason.TransportConfigConflict,
        `Stream ${config.name} has transport-controlled config conflicts that cannot be migrated: ${conflicts}. ` +
          `The retention policy is managed by the transport and must match the stream kind.`,
      );
    }

    if (!diff.hasImmutableChanges) {
      // Mutable-only or enable-only changes: normal update
      this.logger.debug(`Stream exists, updating: ${config.name}`);

      return await runProvisioningOp(ctx, () => jsm.streams.update(config.name, config));
    }

    if (!this.options.provisioning?.allowDestructiveMigration) {
      this.logger.warn(
        `Stream ${config.name} has immutable config conflicts. ` +
          `Enable allowDestructiveMigration to recreate the stream.`,
      );

      // Still apply the mutable subset of the changes
      if (diff.hasMutableChanges) {
        const mutableConfig = this.buildMutableOnlyConfig(config, currentInfo.config, diff);

        return await runProvisioningOp(ctx, () => jsm.streams.update(config.name, mutableConfig));
      }

      return currentInfo;
    }

    if (config.name === this.getStreamName(StreamKind.Schedule)) {
      throw new JetstreamMigrationError(
        MigrationErrorReason.ScheduleStream,
        `Stream ${config.name} is a schedule stream and cannot be migrated: NATS refuses ` +
          'sourcing into a stream with allow_msg_schedules, which the migration relies on. ' +
          'Revert the immutable change, or recreate the stream by hand and let the next boot ' +
          'reconcile the declared schedules (dynamic schedules have to be created again).',
      );
    }

    if (this.isSharedStream(config.name)) {
      throw new JetstreamMigrationError(
        MigrationErrorReason.SharedStream,
        `Stream ${config.name} is shared across services and cannot be destructively migrated: ` +
          "recreating it would delete every other service's durable broadcast consumers and " +
          'replay retained history to them. Coordinate a manual migration instead.',
      );
    }

    await withMigrationSpan(
      this.otel,
      {
        serviceName: this.otelServiceName,
        endpoint: this.otelEndpoint,
        stream: config.name,
        reason: diff.changes
          .filter((c) => c.mutability === 'immutable')
          .map((c) => c.property)
          .join(', '),
      },
      async () => {
        await this.migration.migrate(jsm, config.name, config);
      },
    );

    return await jsm.streams.info(config.name);
  }

  private buildMutableOnlyConfig(
    config: Partial<StreamConfig> & { name: string; subjects: string[] },
    currentConfig: StreamConfig,
    diff: StreamConfigDiffResult,
  ): typeof config {
    const nonMutableKeys = new Set(
      diff.changes
        .filter((c) => c.mutability === 'immutable' || c.mutability === 'transport-controlled')
        .map((c) => c.property),
    );

    const filtered = { ...config };

    for (const key of nonMutableKeys) {
      // Replace desired immutable values with current values so NATS
      // doesn't interpret missing fields as "use default"
      (filtered as Record<string, unknown>)[key] = currentConfig[key];
    }

    return filtered;
  }

  private logChanges(
    streamName: string,
    diff: StreamConfigDiffResult,
    migrationEnabled: boolean,
  ): void {
    for (const c of diff.changes) {
      const detail = `${c.property}: ${JSON.stringify(c.current)} -> ${JSON.stringify(c.desired)}`;

      if (c.mutability === 'transport-controlled') {
        this.logger.error(
          `Stream ${streamName}: ${detail}; transport-controlled, cannot be changed`,
        );
      } else if (c.mutability === 'immutable' && !migrationEnabled) {
        this.logger.warn(`Stream ${streamName}: ${detail}; requires allowDestructiveMigration`);
      } else {
        this.logger.log(`Stream ${streamName}: ${detail}`);
      }
    }
  }

  private buildReservation(
    kind: ReservationKind,
    config: Partial<StreamConfig> & { name: string; subjects: string[] },
  ): StreamReservation {
    const mb = config.max_bytes;

    return {
      kind,
      name: config.name,
      storage: config.storage ?? StorageType.File,
      numReplicas: config.num_replicas ?? 1,
      maxBytes: mb !== undefined && mb >= 0 ? mb : 0, // NATS uses -1 for unlimited
      maxAge: config.max_age ?? 0,
      retention: config.retention ?? RetentionPolicy.Limits,
    };
  }

  private errorContext(
    kind: ReservationKind,
    config: Partial<StreamConfig> & { name: string },
  ): ProvisioningErrorContext {
    return {
      entity: 'stream',
      name: config.name,
      kind,
      maxBytes: config.max_bytes,
      numReplicas: config.num_replicas ?? 1,
    };
  }

  private partitionByManagement(kinds: StreamKind[]): {
    autoKinds: StreamKind[];
    externalKinds: StreamKind[];
  } {
    const autoKinds: StreamKind[] = [];
    const externalKinds: StreamKind[] = [];

    for (const kind of kinds) {
      if (resolveManagementMode(this.options, kind, 'stream') === ManagementMode.Manual) {
        externalKinds.push(kind);
      } else {
        autoKinds.push(kind);
      }
    }

    return { autoKinds, externalKinds };
  }

  private async bindStream(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: StreamKind,
  ): Promise<StreamInfo> {
    return this.withBindSpan(this.names.streamName(kind), () => this.binder.bindStream(jsm, kind));
  }

  private async bindDlqStream(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
  ): Promise<StreamInfo> {
    return this.withBindSpan(this.names.dlqStreamName(), () => this.binder.bindDlqStream(jsm));
  }

  private withBindSpan(name: string, bind: () => Promise<StreamInfo>): Promise<StreamInfo> {
    return withProvisioningSpan(
      this.otel,
      {
        serviceName: this.otelServiceName,
        endpoint: this.otelEndpoint,
        entity: 'stream',
        name,
        action: 'bind',
      },
      bind,
    );
  }

  /** The broadcast stream is global; every service in the cluster shares it. */
  private isSharedStream(name: string): boolean {
    return name === this.getStreamName(StreamKind.Broadcast);
  }

  /** Build the full stream config by merging defaults with user overrides. */
  private buildConfig(
    kind: StreamKind,
  ): Partial<StreamConfig> & { name: string; subjects: string[] } {
    const name = this.getStreamName(kind);
    const subjects = this.getSubjects(kind);
    // A service-specific description on the shared stream would flip-flop on every deploy.
    const description =
      kind === StreamKind.Broadcast
        ? 'JetStream broadcast stream (shared across services)'
        : `JetStream ${kind} stream for ${this.options.name}`;

    const defaults = this.getDefaults(kind);
    const overrides = this.getOverrides(kind);
    const ownership = this.ownership.metadataFor(kind);

    if (
      kind === StreamKind.Schedule &&
      overrides.max_age !== undefined &&
      overrides.max_age !== 0
    ) {
      this.logger.warn(
        `Stream ${name}: schedule.stream.max_age is ${overrides.max_age}ns. ` +
          'A schedule holder that ages out stops its schedule without an error; keep max_age at 0.',
      );
    }

    const metadata = mergeOwnedMetadata(overrides.metadata, ownership);

    return {
      ...defaults,
      ...overrides,
      name,
      subjects,
      description,
      ...(metadata ? { metadata } : {}),
    };
  }

  /**
   * Build the DLQ stream config: library defaults merged with user overrides,
   * with transport-controlled settings like retention stripped.
   */
  private buildDlqConfig(): Partial<StreamConfig> & { name: string; subjects: string[] } {
    const name = this.names.dlqStreamName();
    const subjects = [name];
    const description = `JetStream DLQ stream for ${this.options.name}`;
    const overrides = dlqStreamOverrides(this.options);
    const safeOverrides = this.stripTransportControlled(overrides);
    // The DLQ name is service-scoped like the event and command streams, so two
    // connections of one service reaching the same cluster collide here too.
    const metadata = mergeOwnedMetadata(safeOverrides.metadata, this.ownership.stamp('dlq'));

    return {
      ...DEFAULT_DLQ_STREAM_CONFIG,
      ...safeOverrides,
      name,
      subjects,
      description,
      ...(metadata ? { metadata } : {}),
    };
  }

  /** Get default config for a stream kind. */
  private getDefaults(kind: StreamKind): Partial<StreamConfig> {
    switch (kind) {
      case StreamKind.Event:
        return DEFAULT_EVENT_STREAM_CONFIG;
      case StreamKind.Command:
        return DEFAULT_COMMAND_STREAM_CONFIG;
      case StreamKind.Broadcast:
        return DEFAULT_BROADCAST_STREAM_CONFIG;
      case StreamKind.Ordered:
        return DEFAULT_ORDERED_STREAM_CONFIG;
      case StreamKind.Schedule:
        return DEFAULT_SCHEDULE_STREAM_CONFIG;
    }
  }

  /** Check if scheduling is enabled for a stream kind via `allow_msg_schedules` override. */
  private isSchedulingEnabled(kind: StreamKind): boolean {
    const overrides = this.getOverrides(kind);

    return overrides.allow_msg_schedules === true;
  }

  /** Get user-provided overrides for a stream kind, stripping transport-controlled properties. */
  private getOverrides(kind: StreamKind): Partial<StreamConfig> {
    return this.stripTransportControlled(kindOptionsBlock(this.options, kind)?.stream ?? {});
  }

  /**
   * Remove transport-controlled properties from user overrides.
   * `retention` is managed by the transport (Workqueue/Limits per stream kind)
   * and silently stripped to protect users from misconfiguration.
   */
  private stripTransportControlled(overrides: Partial<StreamConfig>): Partial<StreamConfig> {
    if (!('retention' in overrides)) return overrides;

    this.logger.debug(
      'Stripping user-provided retention override; retention is managed by the transport',
    );

    const cleaned = { ...overrides };

    delete cleaned.retention;

    return cleaned;
  }
}
