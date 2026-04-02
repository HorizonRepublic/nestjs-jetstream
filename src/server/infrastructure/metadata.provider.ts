import { Logger } from '@nestjs/common';
import type { KV } from '@nats-io/kv';
import { Kvm } from '@nats-io/kv';

import { ConnectionProvider } from '../../connection';
import type { JetstreamModuleOptions } from '../../interfaces';
import {
  DEFAULT_METADATA_BUCKET,
  DEFAULT_METADATA_HISTORY,
  DEFAULT_METADATA_REPLICAS,
  DEFAULT_METADATA_TTL,
  MIN_METADATA_TTL,
} from '../../jetstream.constants';

/**
 * Publishes handler metadata to a NATS KV bucket for external service discovery.
 *
 * Uses TTL + heartbeat to manage entry lifecycle:
 * - Entries are written on startup and refreshed every `ttl / 2`
 * - When the pod stops (graceful or crash), heartbeat stops → entries expire via TTL
 * - No explicit delete needed — NATS handles expiry automatically
 *
 * This provider is fully decoupled from stream/consumer infrastructure —
 * it only depends on the NATS connection and module options.
 */
export class MetadataProvider {
  private readonly logger = new Logger('Jetstream:Metadata');
  private readonly bucketName: string;
  private readonly replicas: number;
  private readonly ttl: number;
  private currentEntries?: Map<string, Record<string, unknown>>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  public constructor(
    options: JetstreamModuleOptions,
    private readonly connection: ConnectionProvider,
  ) {
    this.bucketName = options.metadata?.bucket ?? DEFAULT_METADATA_BUCKET;
    this.replicas = options.metadata?.replicas ?? DEFAULT_METADATA_REPLICAS;
    this.ttl = Math.max(options.metadata?.ttl ?? DEFAULT_METADATA_TTL, MIN_METADATA_TTL);
  }

  /**
   * Write handler metadata entries to the KV bucket and start heartbeat.
   *
   * Creates the bucket if it doesn't exist (idempotent).
   * Skips silently when entries map is empty.
   * Starts a heartbeat interval that refreshes entries every `ttl / 2`
   * to prevent TTL expiry while the pod is alive.
   *
   * Non-critical — errors are logged but do not prevent transport startup.
   *
   * @param entries Map of KV key → metadata object.
   */
  public async publish(entries: Map<string, Record<string, unknown>>): Promise<void> {
    if (entries.size === 0) return;

    try {
      const kv = await this.openBucket();

      await this.writeEntries(kv, entries);

      this.currentEntries = entries;
      this.startHeartbeat();
      this.logger.log(
        `Published ${entries.size} handler metadata entries to KV bucket "${this.bucketName}"`,
      );
    } catch (err) {
      this.logger.error('Failed to publish handler metadata to KV', err);
    }
  }

  /**
   * Stop the heartbeat timer.
   *
   * After this call, entries will expire via TTL once the heartbeat window passes.
   * Called during transport shutdown (strategy.close()).
   */
  public destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    this.currentEntries = undefined;
  }

  /** Write entries to KV with per-entry error handling. */
  private async writeEntries(kv: KV, entries: Map<string, Record<string, unknown>>): Promise<void> {
    for (const [key, meta] of entries) {
      try {
        await kv.put(key, JSON.stringify(meta));
      } catch (err) {
        this.logger.error(`Failed to write metadata entry "${key}"`, err);
      }
    }
  }

  /** Start heartbeat interval that refreshes entries every ttl/2. */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    const interval = Math.floor(this.ttl / 2);

    this.heartbeatTimer = setInterval(() => {
      void this.refreshEntries();
    }, interval);

    // Don't keep the Node.js process alive just for metadata heartbeat
    this.heartbeatTimer.unref();
  }

  /** Refresh all current entries in KV (heartbeat tick). */
  private async refreshEntries(): Promise<void> {
    if (!this.currentEntries || this.currentEntries.size === 0) return;

    try {
      const kv = await this.openBucket();

      await this.writeEntries(kv, this.currentEntries);
    } catch (err) {
      this.logger.error('Failed to refresh handler metadata in KV', err);
    }
  }

  /** Create or open the KV bucket (idempotent). */
  private async openBucket(): Promise<KV> {
    const js = this.connection.getJetStreamClient();
    const kvm = new Kvm(js);

    return kvm.create(this.bucketName, {
      history: DEFAULT_METADATA_HISTORY,
      replicas: this.replicas,
      ttl: this.ttl,
    });
  }
}
