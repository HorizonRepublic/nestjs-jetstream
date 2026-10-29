import type { JetStreamManager, StreamConfig, StreamInfo } from '@nats-io/jetstream';

import { ConfigErrorReason, JetstreamConfigError } from '../../errors';
import { ManagementMode, StreamKind } from '../../interfaces';
import type { JetstreamModuleOptions } from '../../interfaces';
import { STREAM_OWNER_METADATA_KEY } from '../../jetstream.constants';
import { resolveManagementMode } from './management';
import { natsErrorCode, NatsErrorCode } from './nats-error-codes';
import { JetstreamProvisioningError } from './provisioning-error';

/**
 * Combine user-supplied stream metadata with the transport's ownership stamp.
 *
 * The stamp augments rather than replaces, so a `metadata` block in the kind's
 * overrides survives. Returns `undefined` when neither side contributes, so the
 * caller can omit the field entirely.
 */
export const mergeOwnedMetadata = (
  overrides: Record<string, string> | undefined,
  ownership: Record<string, string> | undefined,
): Record<string, string> | undefined =>
  overrides || ownership ? { ...overrides, ...ownership } : undefined;

type OwnedStreamConfig = Partial<StreamConfig> & { name: string };

/** JetStream API error code behind either a raw or an already-mapped provisioning error. */
const errorCodeOf = (err: unknown): number | undefined => {
  if (err instanceof JetstreamProvisioningError) return err.errCode;

  return natsErrorCode(err);
};

/** Stamps the streams a connection provisions and refuses ones a sibling connection owns. */
export class StreamOwnership {
  public constructor(private readonly options: JetstreamModuleOptions) {}

  /**
   * Ownership stamp for a stream this connection provisions.
   *
   * The broadcast stream is shared by every service in the cluster, so stamping
   * it would flip-flop on each deploy exactly as a per-service description
   * would. Under Manual management the streams are externally owned and their
   * metadata is not ours to write.
   */
  public metadataFor(kind: StreamKind): Record<string, string> | undefined {
    if (kind === StreamKind.Broadcast) return undefined;

    return this.stamp(kind);
  }

  /** The stamp itself, for any entity whose name is scoped to this service. */
  public stamp(kind: StreamKind | 'dlq'): Record<string, string> | undefined {
    if (resolveManagementMode(this.options, kind, 'stream') === ManagementMode.Manual) {
      return undefined;
    }

    const connection = (this.options as { connectionName?: string }).connectionName ?? 'default';

    return { [STREAM_OWNER_METADATA_KEY]: `${this.options.name}:${connection}` };
  }

  /**
   * Fail when a stream was provisioned by a different connection of this service.
   *
   * Two connections into one cluster resolve identical stream names and would
   * silently overwrite each other's configuration. A stamp from another service
   * is left alone; sharing a stream across services is a separate concern.
   */
  public assertOwnership(currentInfo: StreamInfo, config: OwnedStreamConfig): void {
    const desired = config.metadata?.[STREAM_OWNER_METADATA_KEY];
    const current = currentInfo.config.metadata?.[STREAM_OWNER_METADATA_KEY];

    if (desired === undefined || current === undefined || current === desired) return;
    if (!current.startsWith(`${this.options.name}:`)) return;

    const currentConnection = current.slice(this.options.name.length + 1);
    const desiredConnection = desired.slice(this.options.name.length + 1);

    throw new JetstreamConfigError(
      ConfigErrorReason.StreamOwnershipConflict,
      `Stream ${config.name} is already owned by connection "${currentConnection}", but ` +
        `connection "${desiredConnection}" of the same service is trying to provision it. ` +
        `Both connections resolve the same stream name, which means they reach the same NATS ` +
        `cluster. Point them at distinct clusters or give them distinct service names.`,
    );
  }

  /** Turn a lost create race into an ownership error when the winner is a sibling connection. */
  public async rethrowAsConflict(
    jsm: JetStreamManager,
    config: OwnedStreamConfig,
    createErr: unknown,
  ): Promise<void> {
    if (errorCodeOf(createErr) !== NatsErrorCode.StreamAlreadyExists) return;

    let current: StreamInfo;

    try {
      current = await jsm.streams.info(config.name);
    } catch {
      // The re-read is a diagnostic nicety; if it fails, the caller still gets
      // the original create error rather than this one.
      return;
    }

    this.assertOwnership(current, config);
  }
}
