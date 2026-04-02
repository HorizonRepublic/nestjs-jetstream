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

import { StreamProvider } from './stream.provider';

/** JetStream API error code for missing consumers. */
const CONSUMER_NOT_FOUND = 10014;

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

  /** Ensure a single consumer exists, creating if needed. */
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
      if (err instanceof JetStreamApiError && err.apiError().err_code === CONSUMER_NOT_FOUND) {
        this.logger.log(`Creating consumer: ${name}`);
        return await jsm.consumers.add(stream, config);
      }

      throw err;
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
      default: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const _exhaustive: never = kind;

        throw new Error(`Unexpected StreamKind: ${_exhaustive}`);
      }
    }
  }
}
