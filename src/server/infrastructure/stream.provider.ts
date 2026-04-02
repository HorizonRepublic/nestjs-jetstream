import { Logger } from '@nestjs/common';
import { JetStreamApiError, type StreamConfig, type StreamInfo } from '@nats-io/jetstream';

import { ConnectionProvider } from '../../connection';
import { StreamKind } from '../../interfaces';
import type { JetstreamModuleOptions } from '../../interfaces';
import {
  DEFAULT_BROADCAST_STREAM_CONFIG,
  DEFAULT_COMMAND_STREAM_CONFIG,
  DEFAULT_EVENT_STREAM_CONFIG,
  DEFAULT_ORDERED_STREAM_CONFIG,
  internalName,
  streamName,
} from '../../jetstream.constants';

/** JetStream API error code for missing streams. */
const STREAM_NOT_FOUND = 10059;

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

  public constructor(
    private readonly options: JetstreamModuleOptions,
    private readonly connection: ConnectionProvider,
  ) {}

  /**
   * Ensure all required streams exist with correct configuration.
   *
   * @param kinds Which stream kinds to create. Determined by the module based
   *              on RPC mode and registered handler patterns.
   */
  public async ensureStreams(kinds: StreamKind[]): Promise<void> {
    const jsm = await this.connection.getJetStreamManager();

    await Promise.all(kinds.map((kind) => this.ensureStream(jsm, kind)));
  }

  /** Get the stream name for a given kind. */
  public getStreamName(kind: StreamKind): string {
    return streamName(this.options.name, kind);
  }

  /** Get the subjects pattern for a given kind. */
  public getSubjects(kind: StreamKind): string[] {
    const name = internalName(this.options.name);

    switch (kind) {
      case StreamKind.Event: {
        const subjects = [`${name}.${StreamKind.Event}.>`];

        // When scheduling is enabled, add a schedule-holder subject namespace
        // so scheduled messages reside in the same stream but are NOT matched
        // by the event consumer's filter (which only matches {svc}.ev.>).
        if (this.isSchedulingEnabled(kind)) {
          subjects.push(`${name}._sch.>`);
        }

        return subjects;
      }

      case StreamKind.Command:
        return [`${name}.${StreamKind.Command}.>`];
      case StreamKind.Broadcast: {
        const subjects = ['broadcast.>'];

        if (this.isSchedulingEnabled(kind)) {
          subjects.push('broadcast._sch.>');
        }

        return subjects;
      }

      case StreamKind.Ordered:
        return [`${name}.${StreamKind.Ordered}.>`];
    }
  }

  /** Ensure a single stream exists, creating or updating as needed. */
  private async ensureStream(
    jsm: Awaited<ReturnType<ConnectionProvider['getJetStreamManager']>>,
    kind: StreamKind,
  ): Promise<StreamInfo> {
    const config = this.buildConfig(kind);

    this.logger.log(`Ensuring stream: ${config.name}`);

    try {
      // Try to get existing stream info
      await jsm.streams.info(config.name);
      // Stream exists — update config
      this.logger.debug(`Stream exists, updating: ${config.name}`);
      return await jsm.streams.update(config.name, config);
    } catch (err) {
      if (err instanceof JetStreamApiError && err.apiError().err_code === STREAM_NOT_FOUND) {
        this.logger.log(`Creating stream: ${config.name}`);
        return await jsm.streams.add(config as StreamConfig);
      }

      throw err;
    }
  }

  /** Build the full stream config by merging defaults with user overrides. */
  private buildConfig(
    kind: StreamKind,
  ): Partial<StreamConfig> & { name: string; subjects: string[] } {
    const name = this.getStreamName(kind);
    const subjects = this.getSubjects(kind);
    const description = `JetStream ${kind} stream for ${this.options.name}`;

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
    let overrides: Partial<StreamConfig>;

    switch (kind) {
      case StreamKind.Event:
        overrides = this.options.events?.stream ?? {};
        break;
      case StreamKind.Command:
        overrides = this.options.rpc?.mode === 'jetstream' ? (this.options.rpc.stream ?? {}) : {};
        break;
      case StreamKind.Broadcast:
        overrides = this.options.broadcast?.stream ?? {};
        break;
      case StreamKind.Ordered:
        overrides = this.options.ordered?.stream ?? {};
        break;
    }

    return this.stripTransportControlled(overrides);
  }

  /**
   * Remove transport-controlled properties from user overrides.
   * `retention` is managed by the transport (Workqueue/Limits per stream kind)
   * and silently stripped to protect users from misconfiguration.
   */
  private stripTransportControlled(overrides: Partial<StreamConfig>): Partial<StreamConfig> {
    if (!('retention' in overrides)) return overrides;

    const { retention: _, ...rest } = overrides;

    return rest;
  }
}
