import { Logger } from '@nestjs/common';
import type { KV } from '@nats-io/kv';
import { Kvm } from '@nats-io/kv';

import { ConnectionProvider } from '../../connection';
import type { JetstreamModuleOptions } from '../../interfaces';
import {
  DEFAULT_METADATA_BUCKET,
  DEFAULT_METADATA_CLEANUP_ON_SHUTDOWN,
  DEFAULT_METADATA_HISTORY,
  DEFAULT_METADATA_REPLICAS,
} from '../../jetstream.constants';

/**
 * Publishes handler metadata to a NATS KV bucket for external service discovery.
 *
 * Receives pre-built metadata entries (key → meta) and writes them to KV.
 * Optionally cleans up entries on graceful shutdown.
 *
 * This provider is fully decoupled from stream/consumer infrastructure —
 * it only depends on the NATS connection and module options.
 */
export class MetadataProvider {
  private readonly logger = new Logger('Jetstream:Metadata');
  private readonly bucketName: string;
  private readonly replicas: number;
  private readonly cleanupOnShutdown: boolean;
  private publishedKeys: string[] = [];

  public constructor(
    options: JetstreamModuleOptions,
    private readonly connection: ConnectionProvider,
  ) {
    this.bucketName = options.metadata?.bucket ?? DEFAULT_METADATA_BUCKET;
    this.replicas = options.metadata?.replicas ?? DEFAULT_METADATA_REPLICAS;
    this.cleanupOnShutdown =
      options.metadata?.cleanupOnShutdown ?? DEFAULT_METADATA_CLEANUP_ON_SHUTDOWN;
  }

  /**
   * Write handler metadata entries to the KV bucket.
   *
   * Creates the bucket if it doesn't exist (idempotent).
   * Skips silently when entries map is empty.
   * Non-critical — errors are logged but do not prevent transport startup.
   *
   * @param entries Map of KV key → metadata object.
   */
  public async publish(entries: Map<string, Record<string, unknown>>): Promise<void> {
    if (entries.size === 0) return;

    try {
      const kv = await this.openBucket();

      for (const [key, meta] of entries) {
        await kv.put(key, JSON.stringify(meta));
      }

      this.publishedKeys = [...entries.keys()];
      this.logger.log(
        `Published ${entries.size} handler metadata entries to KV bucket "${this.bucketName}"`,
      );
    } catch (err) {
      this.logger.error('Failed to publish handler metadata to KV', err);
    }
  }

  /**
   * Delete previously published metadata entries from KV.
   *
   * Called during graceful shutdown. Skips when `cleanupOnShutdown` is false
   * or no entries were published. Non-critical — errors are logged.
   */
  public async cleanup(): Promise<void> {
    if (!this.cleanupOnShutdown || this.publishedKeys.length === 0) return;

    try {
      const kv = await this.openBucket();

      for (const key of this.publishedKeys) {
        await kv.delete(key);
      }

      this.logger.log(
        `Cleaned up ${this.publishedKeys.length} metadata entries from KV bucket "${this.bucketName}"`,
      );
      this.publishedKeys = [];
    } catch (err) {
      this.logger.error('Failed to clean up metadata entries', err);
    }
  }

  /** Create or open the KV bucket (idempotent). */
  private async openBucket(): Promise<KV> {
    const js = this.connection.getJetStreamClient();
    const kvm = new Kvm(js);

    return kvm.create(this.bucketName, {
      history: DEFAULT_METADATA_HISTORY,
      replicas: this.replicas,
    });
  }
}
