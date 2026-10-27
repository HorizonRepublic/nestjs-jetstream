import type { JetStreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { JetstreamError } from '../errors/jetstream-error';
import { CapabilityErrorReason, NatsCapability } from './server-capabilities.types';
import type { CapabilityRequirement } from './server-capabilities.types';

/**
 * Measured against real servers. 2.10 reports no level and silently ignores
 * both TTL and schedule flags; 2.11.0 reports 1, 2.12.0 reports 2, 2.14.0 reports 4.
 */
const REQUIREMENTS: Readonly<Record<NatsCapability, CapabilityRequirement>> = {
  [NatsCapability.MessageTtl]: { apiLevel: 1, natsVersion: '2.11' },
  [NatsCapability.MessageSchedules]: { apiLevel: 2, natsVersion: '2.12' },
  [NatsCapability.RecurringSchedules]: { apiLevel: 4, natsVersion: '2.14' },
};

/** A feature was used against a NATS server too old to run it. */
export class JetstreamCapabilityError extends JetstreamError<CapabilityErrorReason> {
  public constructor(
    public readonly capability: NatsCapability,
    public readonly requiredLevel: number,
    public readonly actualLevel: number,
    message: string,
  ) {
    super(CapabilityErrorReason.ServerTooOld, message);
    this.name = 'JetstreamCapabilityError';
  }
}

const levelOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * What the connected JetStream can do, read from its API level (ADR-44).
 *
 * The level is the lower of the connected server's and the account's, which is
 * the meta leader's. Neither is the cluster minimum: during a rolling server
 * upgrade a check can pass while a stream leader still runs an older version.
 */
export class ServerCapabilities {
  public constructor(
    public readonly apiLevel: number,
    public readonly serverLabel: string,
  ) {}

  /** Read the levels the server and the JetStream API report. */
  public static async probe(
    nc: NatsConnection,
    jsm: JetStreamManager,
  ): Promise<ServerCapabilities> {
    const account = await jsm.getAccountInfo();
    const levels = [levelOrNull(nc.info?.api_lvl), levelOrNull(account.api.level)].filter(
      (level): level is number => level !== null,
    );
    const label = `${nc.info?.server_name ?? 'the NATS server'} (NATS ${nc.info?.version ?? 'unknown'})`;

    return new ServerCapabilities(levels.length > 0 ? Math.min(...levels) : 0, label);
  }

  public supports(capability: NatsCapability): boolean {
    return this.apiLevel >= REQUIREMENTS[capability].apiLevel;
  }

  /**
   * @param capability What is about to be used.
   * @param usage Who uses it, for the message, such as `Handler "sync.tick"`.
   * @throws JetstreamCapabilityError when the server is too old.
   */
  public assert(capability: NatsCapability, usage: string): void {
    if (this.supports(capability)) return;

    const { apiLevel, natsVersion } = REQUIREMENTS[capability];

    throw new JetstreamCapabilityError(
      capability,
      apiLevel,
      this.apiLevel,
      `${usage} needs NATS JetStream API level ${apiLevel} (NATS ${natsVersion} or newer); ` +
        `${this.serverLabel} reports level ${this.apiLevel}.`,
    );
  }
}
