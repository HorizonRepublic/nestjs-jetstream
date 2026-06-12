import { Logger } from '@nestjs/common';
import {
  JetStreamApiError,
  RetentionPolicy,
  StorageType,
  type StreamConfig,
  type StreamInfo,
} from '@nats-io/jetstream';

import { ConnectionProvider } from '../../connection';
import { ManagementMode, StreamKind } from '../../interfaces';
import type { JetstreamModuleOptions } from '../../interfaces';
import {
  DEFAULT_BROADCAST_STREAM_CONFIG,
  DEFAULT_COMMAND_STREAM_CONFIG,
  DEFAULT_EVENT_STREAM_CONFIG,
  DEFAULT_ORDERED_STREAM_CONFIG,
  DEFAULT_DLQ_STREAM_CONFIG,
} from '../../jetstream.constants';
import { NameResolver } from './name-resolver';
import {
  deriveOtelAttrs,
  withMigrationSpan,
  withProvisioningSpan,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../../otel';
import { NatsErrorCode } from './nats-error-codes';
import { assertStorageBudget } from './provisioning-budget';
import { mapProvisioningError, type ProvisioningErrorContext } from './provisioning-error';
import {
  formatProvisioningSummary,
  type ExternalBinding,
  type ReservationKind,
  type StreamReservation,
} from './provisioning-summary';
import { kindOptionsBlock, resolveManagementMode } from './management';
import { InfrastructureBinder } from './infrastructure-binder';
import { compareStreamConfig, type StreamConfigDiffResult } from './stream-config-diff';
import { StreamMigration } from './stream-migration';
import { subjectCovers } from './subject-utils';

/**
 * Manages JetStream stream lifecycle: creation, updates, and idempotent ensures.
 *
 * Creates up to three stream types depending on configuration:
 * - **Event stream** — workqueue events (always, when consumer enabled)
 * - **Command stream** — RPC commands (only in jetstream RPC mode)
 * - **Broadcast stream** — fan-out events (only if broadcast handlers exist)
 *
 * All operations are idempotent: safe to call on every startup and reconnection.
 */
export class StreamProvider {
  private readonly logger = new Logger('Jetstream:Stream');
  private readonly migration = new StreamMigration();

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

    const dlqIsManual =
      !!this.options.dlq &&
      resolveManagementMode(this.options, 'dlq', 'stream') === ManagementMode.Manual;

    if (this.options.dlq) {
      if (dlqIsManual) {
        external.push({ kind: 'dlq', name: this.names.dlqStreamName() });
      } else {
        reservations.push(this.buildReservation('dlq', this.buildDlqConfig()));
      }
    }

    this.logger.log(`\n${formatProvisioningSummary(this.options.name, reservations, external)}`);

    if (this.options.provisioning?.preflightStorageCheck && reservations.length > 0) {
      await assertStorageBudget(jsm, this.options.name, reservations, this.logger);
    }

    await Promise.all([
      ...autoKinds.map((kind) => this.ensureStream(jsm, kind)),
      ...externalKinds.map((kind) => this.bindStream(jsm, kind)),
    ]);

    if (this.options.dlq) {
      if (dlqIsManual) {
        await this.bindDlqStream(jsm);
      } else {
        await this.ensureDlqStream(jsm);
      }
    }
  }

  /** Get the stream name for a given kind. */
  public getStreamName(kind: StreamKind): string {
    return this.names.streamName(kind);
  }

  /** Get the subjects pattern for a given kind. */
  public getSubjects(kind: StreamKind): string[] {
    const filter = this.names.filterSubject(kind);
    const dedicatedSchedule =
      kind === StreamKind.Event &&
      this.isSchedulingEnabled(kind) &&
      !this.names.hasCustomPrefix(kind);

    return dedicatedSchedule ? [filter, `${this.names.schedulePrefix(kind)}>`] : [filter];
  }

  /** Ensure a single stream exists, creating or updating as needed. */
  private async ensureStream(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: StreamKind,
  ): Promise<StreamInfo> {
    const config = this.buildConfig(kind);
    const ctx = this.errorContext(kind, config);

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
        this.logger.log(`Ensuring stream: ${config.name}`);

        // Finish any migration a previous process left unfinished.
        await this.migration.recoverInterrupted(jsm, config.name, config);

        try {
          const currentInfo = await jsm.streams.info(config.name);

          return await this.handleExistingStream(jsm, currentInfo, config, ctx);
        } catch (err) {
          if (
            err instanceof JetStreamApiError &&
            err.apiError().err_code === NatsErrorCode.StreamNotFound
          ) {
            this.logger.log(`Creating stream: ${config.name}`);

            return await this.runStreamOp(ctx, () => jsm.streams.add(config as StreamConfig));
          }

          throw err;
        }
      },
    );
  }

  /** Ensure a dead-letter queue stream exists, creating or updating as needed. */
  private async ensureDlqStream(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
  ): Promise<StreamInfo> {
    const config = this.buildDlqConfig();
    const ctx = this.errorContext('dlq', config);

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
        this.logger.log(`Ensuring DLQ stream: ${config.name}`);

        try {
          const currentInfo = await jsm.streams.info(config.name);

          return await this.handleExistingStream(jsm, currentInfo, config, ctx);
        } catch (err) {
          if (
            err instanceof JetStreamApiError &&
            err.apiError().err_code === NatsErrorCode.StreamNotFound
          ) {
            this.logger.log(`Creating DLQ stream: ${config.name}`);

            return await this.runStreamOp(ctx, () => jsm.streams.add(config as StreamConfig));
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

    const diff = compareStreamConfig(currentInfo.config, config);

    if (!diff.hasChanges) {
      this.logger.debug(`Stream ${config.name}: no config changes`);
      return currentInfo;
    }

    this.logChanges(config.name, diff, !!this.options.allowDestructiveMigration);

    if (diff.hasTransportControlledConflicts) {
      const conflicts = diff.changes
        .filter((c) => c.mutability === 'transport-controlled')
        .map((c) => `${c.property}: ${JSON.stringify(c.current)} → ${JSON.stringify(c.desired)}`)
        .join(', ');

      throw new Error(
        `Stream ${config.name} has transport-controlled config conflicts that cannot be migrated: ${conflicts}. ` +
          `The retention policy is managed by the transport and must match the stream kind.`,
      );
    }

    if (!diff.hasImmutableChanges) {
      // Mutable-only or enable-only — normal update
      this.logger.debug(`Stream exists, updating: ${config.name}`);

      return await this.runStreamOp(ctx, () => jsm.streams.update(config.name, config));
    }

    // Immutable changes detected
    if (!this.options.allowDestructiveMigration) {
      this.logger.warn(
        `Stream ${config.name} has immutable config conflicts. ` +
          `Enable allowDestructiveMigration to recreate the stream.`,
      );

      // Apply mutable-only changes by building config without immutable overrides
      if (diff.hasMutableChanges) {
        const mutableConfig = this.buildMutableOnlyConfig(config, currentInfo.config, diff);

        return await this.runStreamOp(ctx, () => jsm.streams.update(config.name, mutableConfig));
      }

      return currentInfo;
    }

    if (this.isSharedStream(config.name)) {
      throw new Error(
        `Stream ${config.name} is shared across services and cannot be destructively migrated: ` +
          "recreating it would delete every other service's durable broadcast consumers and " +
          'replay retained history to them. Coordinate a manual migration instead.',
      );
    }

    // Destructive migration
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
      const detail = `${c.property}: ${JSON.stringify(c.current)} → ${JSON.stringify(c.desired)}`;

      if (c.mutability === 'transport-controlled') {
        this.logger.error(
          `Stream ${streamName}: ${detail} — transport-controlled, cannot be changed`,
        );
      } else if (c.mutability === 'immutable' && !migrationEnabled) {
        this.logger.warn(`Stream ${streamName}: ${detail} — requires allowDestructiveMigration`);
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

  private async runStreamOp<T>(ctx: ProvisioningErrorContext, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof JetStreamApiError) {
        throw mapProvisioningError(err, ctx);
      }

      throw err;
    }
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
    const name = this.names.streamName(kind);

    return withProvisioningSpan(
      this.otel,
      {
        serviceName: this.otelServiceName,
        endpoint: this.otelEndpoint,
        entity: 'stream',
        name,
        action: 'bind',
      },
      () => this.binder.bindStream(jsm, kind),
    );
  }

  private async bindDlqStream(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
  ): Promise<StreamInfo> {
    const name = this.names.dlqStreamName();

    return withProvisioningSpan(
      this.otel,
      {
        serviceName: this.otelServiceName,
        endpoint: this.otelEndpoint,
        entity: 'stream',
        name,
        action: 'bind',
      },
      () => this.binder.bindDlqStream(jsm),
    );
  }

  /** The broadcast stream is global — every service in the cluster shares it. */
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

    return {
      ...defaults,
      ...overrides,
      name,
      subjects,
      description,
    };
  }

  /**
   * Build the stream configuration for the Dead-Letter Queue (DLQ).
   *
   * Merges the library default DLQ config with user-provided overrides.
   * Ensures transport-controlled settings like retention are safely decoupled.
   */
  private buildDlqConfig(): Partial<StreamConfig> & { name: string; subjects: string[] } {
    const name = this.names.dlqStreamName();
    const subjects = [name];
    const description = `JetStream DLQ stream for ${this.options.name}`;
    const overrides = this.options.dlq?.stream ?? {};
    const safeOverrides = this.stripTransportControlled(overrides);

    return {
      ...DEFAULT_DLQ_STREAM_CONFIG,
      ...safeOverrides,
      name,
      subjects,
      description,
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
      'Stripping user-provided retention override — retention is managed by the transport',
    );

    const cleaned = { ...overrides };

    delete cleaned.retention;

    return cleaned;
  }
}
