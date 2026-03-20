import { Logger } from '@nestjs/common';
import { ConsumerConfig, ConsumerInfo, NatsError } from 'nats';

import { ConnectionProvider } from '../../connection';
import type { JetstreamModuleOptions, StreamKind } from '../../interfaces';
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
  private async ensureConsumer(
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
      if (err instanceof NatsError && err.api_error?.err_code === CONSUMER_NOT_FOUND) {
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
    if (kind === 'broadcast') {
      // Use specific broadcast patterns from the registry instead of a wildcard
      const broadcastPatterns = this.patternRegistry.getBroadcastPatterns();

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

    // Build filter_subject based on kind
    const filter_subject = kind === 'ev' ? `${serviceName}.ev.>` : `${serviceName}.cmd.>`;

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
      case 'ev':
        return DEFAULT_EVENT_CONSUMER_CONFIG;
      case 'cmd':
        return DEFAULT_COMMAND_CONSUMER_CONFIG;
      case 'broadcast':
        return DEFAULT_BROADCAST_CONSUMER_CONFIG;
    }
  }

  /** Get user-provided overrides for a consumer kind. */
  private getOverrides(kind: StreamKind): Partial<ConsumerConfig> {
    switch (kind) {
      case 'ev':
        return this.options.events?.consumer ?? {};
      case 'cmd':
        return this.options.rpc?.mode === 'jetstream' ? (this.options.rpc.consumer ?? {}) : {};
      case 'broadcast':
        return this.options.broadcast?.consumer ?? {};
    }
  }
}
