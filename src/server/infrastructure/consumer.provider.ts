import { Logger } from '@nestjs/common';

import {
  DeliverPolicy,
  JetStreamApiError,
  type ConsumerConfig,
  type ConsumerInfo,
} from '@nats-io/jetstream';

import { ConnectionProvider } from '../../connection';
import {
  BindingErrorReason,
  JetstreamBindingError,
  JetstreamMigrationError,
  MigrationErrorReason,
} from '../../errors';
import { ManagementMode, StreamKind } from '../../interfaces';
import type { JetstreamModuleOptions } from '../../interfaces';
import {
  DEFAULT_BROADCAST_CONSUMER_CONFIG,
  DEFAULT_SCHEDULE_CONSUMER_CONFIG,
  DEFAULT_COMMAND_CONSUMER_CONFIG,
  DEFAULT_EVENT_CONSUMER_CONFIG,
} from '../../jetstream.constants';
import {
  deriveOtelAttrs,
  withProvisioningSpan,
  type ProvisioningSpanContext,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../../otel';
import { PatternRegistry } from '../routing';
import { InfrastructureBinder } from './infrastructure-binder';
import { kindOptionsBlock, resolveManagementMode } from './management';
import { NameResolver } from './name-resolver';
import { isNatsError, NatsErrorCode } from './nats-error-codes';
import {
  mapProvisioningError,
  runProvisioningOp,
  type ProvisioningErrorContext,
} from './provisioning-error';
import { MIGRATION_BACKUP_SUFFIX } from './stream-migration';
import { StreamProvider } from './stream.provider';

type ProvisioningSpanTarget = Omit<ProvisioningSpanContext, 'action'>;

type DurableConsumerConfig = Partial<ConsumerConfig> & { durable_name: string };

interface ConsumerTarget {
  readonly stream: string;
  readonly name: string;
  readonly config: DurableConsumerConfig;
  readonly spanAttrs: ProvisioningSpanTarget;
}
import { minimalSubjectFilters } from './subject-utils';

/** One subject goes in `filter_subject`; any other count in `filter_subjects`. */
const consumerFilter = (subjects: string[]): Partial<ConsumerConfig> =>
  subjects.length === 1 ? { filter_subject: subjects[0] } : { filter_subjects: subjects };

/**
 * Manages JetStream consumer lifecycle: creation and idempotent ensures.
 *
 * Creates durable pull-based consumers that survive restarts.
 * Consumer configuration is merged from defaults and user overrides.
 */
export class ConsumerProvider {
  private readonly logger = new Logger('Jetstream:Consumer');

  private readonly otel: ResolvedOtelOptions;
  private readonly otelServiceName: string;
  private readonly otelEndpoint: ServerEndpoint | null;

  public constructor(
    private readonly options: JetstreamModuleOptions,
    private readonly connection: ConnectionProvider,
    private readonly streamProvider: StreamProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly names: NameResolver,
    private readonly binder: InfrastructureBinder,
  ) {
    const derived = deriveOtelAttrs(options);

    this.otel = derived.otel;
    this.otelServiceName = derived.serviceName;
    this.otelEndpoint = derived.serverEndpoint;
  }

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
    return this.names.consumerName(kind);
  }

  /**
   * Ensure a single consumer exists with the desired config.
   * Startup path: creates or updates the consumer to match the current pod's configuration.
   */
  public async ensureConsumer(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: StreamKind,
  ): Promise<ConsumerInfo> {
    const target = this.resolveTarget(kind);
    const { stream, name, config } = target;

    if (resolveManagementMode(this.options, kind, 'consumer') === ManagementMode.Manual) {
      return withProvisioningSpan(this.otel, { ...target.spanAttrs, action: 'bind' }, () =>
        this.binder.bindConsumer(jsm, kind),
      );
    }

    return withProvisioningSpan(this.otel, { ...target.spanAttrs, action: 'ensure' }, async () => {
      this.logger.log(`Ensuring consumer: ${name} on stream: ${stream}`);

      const ctx: ProvisioningErrorContext = { entity: 'consumer', name, kind };

      return this.lookupOrCreate(jsm, kind, target, async () => {
        const existing = await jsm.consumers.info(stream, name);

        if (await this.startsPastStream(jsm, kind, existing)) {
          this.logger.warn(
            `Consumer ${name} starts at stream sequence ${existing.config.opt_start_seq}, past ` +
              `the end of ${stream}, which was recreated; recreating it from the start`,
          );
          await jsm.consumers.delete(stream, name);

          return await this.createConsumer(jsm, stream, name, kind, config);
        }

        this.logger.debug(`Consumer exists, updating: ${name}`);

        const update = this.keepStartPosition(kind, existing.config, config);

        return await runProvisioningOp(ctx, () => jsm.consumers.update(stream, name, update));
      });
    });
  }

  /**
   * Recover a consumer that disappeared during runtime.
   *
   * Self-healing path: creates if missing but never updates config, so an old pod
   * cannot overwrite a newer pod's config during rolling updates. If a migration
   * backup stream exists, throws so the retry loop backs off until migration completes;
   * creating a consumer mid-migration would eat workqueue messages being restored.
   *
   * @param lastKnown - The consumer as last read before it vanished; a recreated
   *   broadcast durable resumes after its ack floor instead of replaying history.
   */
  public async recoverConsumer(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: StreamKind,
    lastKnown?: ConsumerInfo | undefined,
  ): Promise<ConsumerInfo> {
    const target = this.resolveTarget(kind);
    const { stream, name } = target;

    if (resolveManagementMode(this.options, kind, 'consumer') === ManagementMode.Manual) {
      return withProvisioningSpan(
        this.otel,
        { ...target.spanAttrs, action: 'rebind' },
        async () => {
          try {
            return await jsm.consumers.info(stream, name);
          } catch (err) {
            if (isNatsError(err, NatsErrorCode.ConsumerNotFound)) {
              throw new JetstreamBindingError(
                BindingErrorReason.ExternalConsumerAbsent,
                `Consumer ${name} on ${stream} is externally managed and currently absent; ` +
                  `waiting for it to be restored.`,
                { cause: err },
              );
            }

            throw err;
          }
        },
      );
    }

    return withProvisioningSpan(this.otel, { ...target.spanAttrs, action: 'recover' }, async () => {
      this.logger.log(`Recovering consumer: ${name} on stream: ${stream}`);

      // The migration backup stream acts as a lock held by the migrating pod
      await this.assertNoMigrationInProgress(jsm, stream);

      const resumed = {
        ...target,
        config: await this.resumeConfig(jsm, kind, target, lastKnown),
      };

      // Another pod may have recreated the consumer; use it as-is
      return this.lookupOrCreate(jsm, kind, resumed, () => jsm.consumers.info(stream, name));
    });
  }

  /**
   * A broadcast stream keeps its history, so a durable recreated with
   * `DeliverPolicy.All` would replay all of it. Resume after the last known
   * ack floor instead, unless the stream was recreated since and its
   * sequences started over.
   */
  private async resumeConfig(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: StreamKind,
    target: ConsumerTarget,
    lastKnown: ConsumerInfo | undefined,
  ): Promise<DurableConsumerConfig> {
    const { config, stream } = target;

    if (kind !== StreamKind.Broadcast || this.hasStartOverride(kind) || lastKnown === undefined) {
      return config;
    }

    const startSeq = lastKnown.ack_floor.stream_seq + 1;
    const { created, state } = await jsm.streams.info(stream);

    if (startSeq > state.last_seq + 1 || Date.parse(created) > Date.parse(lastKnown.created)) {
      this.logger.warn(
        `Consumer ${config.durable_name}: ${stream} was recreated since the consumer was last ` +
          'read; recreating it from the start of the stream',
      );

      return config;
    }

    this.logger.warn(
      `Consumer ${config.durable_name}: resuming from stream sequence ${startSeq}, after its ` +
        'last known ack floor; broadcasts acknowledged after that may be delivered again.',
    );

    return { ...config, deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: startSeq };
  }

  /** A start sequence past the end of the stream would deliver nothing until the stream got there. */
  private async startsPastStream(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: StreamKind,
    existing: ConsumerInfo,
  ): Promise<boolean> {
    const { deliver_policy: policy, opt_start_seq: startSeq } = existing.config;

    if (this.hasStartOverride(kind) || policy !== DeliverPolicy.StartSequence) return false;

    const { state } = await jsm.streams.info(existing.stream_name);

    return (startSeq ?? 0) > state.last_seq + 1;
  }

  /**
   * The start position cannot change on update. Keep the one a recreated
   * consumer resumed from unless the user configured a start of their own.
   */
  private keepStartPosition(
    kind: StreamKind,
    existing: ConsumerConfig,
    config: DurableConsumerConfig,
  ): DurableConsumerConfig {
    if (this.hasStartOverride(kind) || existing.deliver_policy === config.deliver_policy) {
      return config;
    }

    return {
      ...config,
      deliver_policy: existing.deliver_policy,
      opt_start_seq: existing.opt_start_seq,
      opt_start_time: existing.opt_start_time,
    };
  }

  private hasStartOverride(kind: StreamKind): boolean {
    return this.getOverrides(kind).deliver_policy !== undefined;
  }

  private resolveTarget(kind: StreamKind): ConsumerTarget {
    const stream = this.streamProvider.getStreamName(kind);
    const config = this.buildConfig(kind);
    const name = config.durable_name;

    return {
      stream,
      name,
      config,
      spanAttrs: {
        serviceName: this.otelServiceName,
        endpoint: this.otelEndpoint,
        entity: 'consumer',
        name,
      },
    };
  }

  /** Run the lookup, creating the consumer when the server reports it missing. */
  private async lookupOrCreate(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: StreamKind,
    target: ConsumerTarget,
    lookup: () => Promise<ConsumerInfo>,
  ): Promise<ConsumerInfo> {
    try {
      return await lookup();
    } catch (err) {
      if (!isNatsError(err, NatsErrorCode.ConsumerNotFound)) throw err;

      return await this.createConsumer(jsm, target.stream, target.name, kind, target.config);
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

      throw new JetstreamMigrationError(
        MigrationErrorReason.InProgress,
        `Stream ${stream} is being migrated (backup ${backupName} exists). ` +
          `Waiting for migration to complete before recovering consumer.`,
      );
    } catch (err) {
      // StreamNotFound means no backup, so no migration in progress
      if (isNatsError(err, NatsErrorCode.StreamNotFound)) {
        return;
      }

      // Re-throws our own "migration in progress" error as well as unexpected ones
      throw err;
    }
  }

  /** Create a consumer, handling the race where another pod creates it first. */
  private async createConsumer(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    stream: string,
    name: string,
    kind: StreamKind,
    config: DurableConsumerConfig,
  ): Promise<ConsumerInfo> {
    this.logger.log(`Creating consumer: ${name}`);

    const ctx: ProvisioningErrorContext = { entity: 'consumer', name, kind };

    try {
      return await jsm.consumers.add(stream, config);
    } catch (addErr) {
      if (isNatsError(addErr, NatsErrorCode.ConsumerAlreadyExists)) {
        this.logger.debug(`Consumer ${name} created by another pod, using existing`);

        return await jsm.consumers.info(stream, name);
      }

      if (addErr instanceof JetStreamApiError) {
        throw mapProvisioningError(addErr, ctx);
      }

      throw addErr;
    }
  }

  /** Build consumer config by merging defaults with user overrides. */
  private buildConfig(kind: StreamKind): DurableConsumerConfig {
    const durableName = this.getConsumerName(kind);

    const defaults = this.getDefaults(kind);
    const overrides = this.getOverrides(kind);

    return {
      ...defaults,
      ...overrides,
      name: durableName,
      durable_name: durableName,
      ...consumerFilter(minimalSubjectFilters(this.filterSubjects(kind))),
    };
  }

  private filterSubjects(kind: StreamKind): string[] {
    if (kind === StreamKind.Broadcast) {
      const broadcastPatterns = this.patternRegistry.getBroadcastPatterns();

      if (broadcastPatterns.length === 0) {
        throw new Error('Broadcast consumer requested but no broadcast patterns are registered');
      }

      return broadcastPatterns;
    }

    if (kind !== StreamKind.Event && kind !== StreamKind.Command && kind !== StreamKind.Schedule) {
      throw new Error(`Unexpected durable consumer kind: ${kind}`);
    }

    if (this.names.hasCustomPrefix(kind)) {
      return this.handlerPatterns(kind).map((p) => this.names.subject(kind, p));
    }

    return [this.names.filterSubject(kind)];
  }

  private handlerPatterns(kind: StreamKind): string[] {
    if (kind === StreamKind.Event) return this.patternRegistry.getEventPatterns();
    if (kind === StreamKind.Schedule) return this.patternRegistry.getPatternsByKind().schedules;

    return this.patternRegistry.getCommandPatterns();
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
      case StreamKind.Schedule:
        return DEFAULT_SCHEDULE_CONSUMER_CONFIG;
      case StreamKind.Ordered:
        throw new Error('Ordered consumers are ephemeral and should not use durable config');
      /* v8 ignore next 5 -- exhaustive switch guard, unreachable */
      default: {
        const _exhaustive: never = kind;

        throw new Error(`Unexpected StreamKind: ${String(_exhaustive)}`);
      }
    }
  }

  /** Get user-provided overrides for a consumer kind. */
  private getOverrides(kind: StreamKind): Partial<ConsumerConfig> {
    return kindOptionsBlock(this.options, kind)?.consumer ?? {};
  }
}
