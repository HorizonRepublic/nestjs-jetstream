import { Logger } from '@nestjs/common';
import { JetStreamApiError, type ConsumerConfig, type ConsumerInfo } from '@nats-io/jetstream';

import { ConnectionProvider } from '../../connection';
import { StreamKind } from '../../interfaces';
import type { JetstreamModuleOptions } from '../../interfaces';
import {
  consumerName,
  DEFAULT_BROADCAST_CONSUMER_CONFIG,
  DEFAULT_COMMAND_CONSUMER_CONFIG,
  DEFAULT_EVENT_CONSUMER_CONFIG,
  internalName,
} from '../../jetstream.constants';
import { PatternRegistry } from '../routing';

import { NatsErrorCode } from './nats-error-codes';
import { MIGRATION_BACKUP_SUFFIX } from './stream-migration';
import { StreamProvider } from './stream.provider';

/**
 * Manages JetStream consumer lifecycle: creation and idempotent ensures.
 *
 * Creates durable pull-based consumers that survive restarts.
 * Consumer configuration is merged from defaults and user overrides.
 */
export class ConsumerProvider {
  private readonly logger = new Logger('Jetstream:Consumer');

  public constructor(
    private readonly options: JetstreamModuleOptions,
    private readonly connection: ConnectionProvider,
    private readonly streamProvider: StreamProvider,
    private readonly patternRegistry: PatternRegistry,
  ) {}

  /**
   * Ensure consumers exist for the specified kinds.
   *
   * @returns Map of kind -> ConsumerInfo for downstream use.
   */
  public async ensureConsumers(kinds: StreamKind[]): Promise<Map<StreamKind, ConsumerInfo>> {
    const jsm = await this.connection.getJetStreamManager();
    const results = new Map<StreamKind, ConsumerInfo>();

    await Promise.all(
      kinds.map(async (kind) => {
        const info = await this.ensureConsumer(jsm, kind);

        results.set(kind, info);
      }),
    );

    return results;
  }

  /** Get the consumer name for a given kind. */
  public getConsumerName(kind: StreamKind): string {
    return consumerName(this.options.name, kind);
  }

  /**
   * Ensure a single consumer exists with the desired config.
   * Used at **startup** — creates or updates the consumer to match
   * the current pod's configuration.
   */
  public async ensureConsumer(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: StreamKind,
  ): Promise<ConsumerInfo> {
    const stream = this.streamProvider.getStreamName(kind);
    const config = this.buildConfig(kind);
    const name = config.durable_name;

    this.logger.log(`Ensuring consumer: ${name} on stream: ${stream}`);

    try {
      await jsm.consumers.info(stream, name);
      this.logger.debug(`Consumer exists, updating: ${name}`);

      return await jsm.consumers.update(stream, name, config);
    } catch (err) {
      if (
        !(err instanceof JetStreamApiError) ||
        err.apiError().err_code !== NatsErrorCode.ConsumerNotFound
      ) {
        throw err;
      }

      return await this.createConsumer(jsm, stream, name, config);
    }
  }

  /**
   * Recover a consumer that disappeared during runtime.
   * Used by **self-healing** — creates if missing, but NEVER updates config.
   *
   * If a migration backup stream exists, another pod is mid-migration — we
   * throw so the self-healing retry loop waits with backoff until migration
   * completes and the backup is cleaned up.
   *
   * This prevents old pods from:
   * - Overwriting a newer pod's consumer config during rolling updates
   * - Creating consumers during migration (which would consume and delete
   *   workqueue messages while they're being restored)
   */
  public async recoverConsumer(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: StreamKind,
  ): Promise<ConsumerInfo> {
    const stream = this.streamProvider.getStreamName(kind);
    const config = this.buildConfig(kind);
    const name = config.durable_name;

    this.logger.log(`Recovering consumer: ${name} on stream: ${stream}`);

    // Check if another pod is mid-migration — backup stream acts as a lock
    await this.assertNoMigrationInProgress(jsm, stream);

    try {
      // Consumer already exists (another pod may have recreated it) — use as-is
      return await jsm.consumers.info(stream, name);
    } catch (err) {
      if (
        !(err instanceof JetStreamApiError) ||
        err.apiError().err_code !== NatsErrorCode.ConsumerNotFound
      ) {
        throw err;
      }

      return await this.createConsumer(jsm, stream, name, config);
    }
  }

  /**
   * Throw if a migration backup stream exists for this stream.
   * The self-healing retry loop catches the error and retries with backoff,
   * naturally waiting until the migrating pod finishes and cleans up the backup.
   */
  private async assertNoMigrationInProgress(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    stream: string,
  ): Promise<void> {
    const backupName = `${stream}${MIGRATION_BACKUP_SUFFIX}`;

    try {
      await jsm.streams.info(backupName);

      // Backup exists → migration in progress
      throw new Error(
        `Stream ${stream} is being migrated (backup ${backupName} exists). ` +
          `Waiting for migration to complete before recovering consumer.`,
      );
    } catch (err) {
      // Backup doesn't exist → no migration in progress → proceed
      if (
        err instanceof JetStreamApiError &&
        err.apiError().err_code === NatsErrorCode.StreamNotFound
      ) {
        return;
      }

      // Re-throw: either the "migration in progress" error or an unexpected error
      throw err;
    }
  }

  /**
   * Create a consumer, handling the race where another pod creates it first.
   */
  private async createConsumer(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    stream: string,
    name: string,
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- NATS API uses snake_case */
    config: Partial<ConsumerConfig> & { durable_name: string },
  ): Promise<ConsumerInfo> {
    this.logger.log(`Creating consumer: ${name}`);

    try {
      return await jsm.consumers.add(stream, config);
    } catch (addErr) {
      if (
        addErr instanceof JetStreamApiError &&
        addErr.apiError().err_code === NatsErrorCode.ConsumerAlreadyExists
      ) {
        this.logger.debug(`Consumer ${name} created by another pod, using existing`);

        return await jsm.consumers.info(stream, name);
      }

      throw addErr;
    }
  }

  /** Build consumer config by merging defaults with user overrides. */
  // eslint-disable-next-line @typescript-eslint/naming-convention -- NATS API uses snake_case
  private buildConfig(kind: StreamKind): Partial<ConsumerConfig> & { durable_name: string } {
    const name = this.getConsumerName(kind);
    const serviceName = internalName(this.options.name);

    const defaults = this.getDefaults(kind);
    const overrides = this.getOverrides(kind);

    /* eslint-disable @typescript-eslint/naming-convention -- NATS API uses snake_case */
    if (kind === StreamKind.Broadcast) {
      const broadcastPatterns = this.patternRegistry.getBroadcastPatterns();

      if (broadcastPatterns.length === 0) {
        throw new Error('Broadcast consumer requested but no broadcast patterns are registered');
      }

      if (broadcastPatterns.length === 1) {
        return {
          ...defaults,
          ...overrides,
          name,
          durable_name: name,
          filter_subject: broadcastPatterns[0],
        };
      }

      return {
        ...defaults,
        ...overrides,
        name,
        durable_name: name,
        filter_subjects: broadcastPatterns,
      };
    }

    if (kind !== StreamKind.Event && kind !== StreamKind.Command) {
      throw new Error(`Unexpected durable consumer kind: ${kind}`);
    }

    const filter_subject = `${serviceName}.${kind}.>`;

    return {
      ...defaults,
      ...overrides,
      name,
      durable_name: name,
      filter_subject,
    };
    /* eslint-enable @typescript-eslint/naming-convention */
  }

  /** Get default config for a consumer kind. */
  private getDefaults(kind: StreamKind): Partial<ConsumerConfig> {
    switch (kind) {
      case StreamKind.Event:
        return DEFAULT_EVENT_CONSUMER_CONFIG;
      case StreamKind.Command:
        return DEFAULT_COMMAND_CONSUMER_CONFIG;
      case StreamKind.Broadcast:
        return DEFAULT_BROADCAST_CONSUMER_CONFIG;
      case StreamKind.Ordered:
        throw new Error('Ordered consumers are ephemeral and should not use durable config');
      /* v8 ignore next 5 -- exhaustive switch guard, unreachable */
      default: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const _exhaustive: never = kind;

        throw new Error(`Unexpected StreamKind: ${_exhaustive}`);
      }
    }
  }

  /** Get user-provided overrides for a consumer kind. */
  private getOverrides(kind: StreamKind): Partial<ConsumerConfig> {
    switch (kind) {
      case StreamKind.Event:
        return this.options.events?.consumer ?? {};
      case StreamKind.Command:
        return this.options.rpc?.mode === 'jetstream' ? (this.options.rpc.consumer ?? {}) : {};
      case StreamKind.Broadcast:
        return this.options.broadcast?.consumer ?? {};
      case StreamKind.Ordered:
        throw new Error('Ordered consumers are ephemeral and should not use durable config');
      /* v8 ignore next 5 -- exhaustive switch guard, unreachable */
      default: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const _exhaustive: never = kind;

        throw new Error(`Unexpected StreamKind: ${_exhaustive}`);
      }
    }
  }
}
