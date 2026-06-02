import { type Logger } from '@nestjs/common';
import { type JetStreamManager, StorageType } from '@nats-io/jetstream';

import { type StreamReservation } from './provisioning-summary';

const GIB = 1024 ** 3;

const fmt = (bytes: number): string => `${(bytes / GIB).toFixed(2)} GiB`;

/* eslint-disable @typescript-eslint/naming-convention */
/** File-storage limits as exposed by account/tier info. */
interface AccountStorageLimits {
  readonly max_storage?: number;
}

/** Defensive view of `getAccountInfo()` — fields may be absent on partial/unexpected shapes. */
interface AccountInfoView {
  readonly limits?: AccountStorageLimits;
  readonly reserved_storage?: number;
  readonly tiers?: Record<string, AccountInfoView | undefined>;
}
/* eslint-enable @typescript-eslint/naming-convention */

/** Resolved file-storage budget for one replica tier. */
interface TierBudget {
  readonly maxStorage: number;
  readonly reserved: number;
  readonly tiered: boolean;
}

/** Pick the tier-specific limit when present, else fall back to the account aggregate. */
const resolveTierBudget = (info: AccountInfoView, replicas: number): TierBudget => {
  const tier = info.tiers?.[`R${replicas}`];
  const limits = tier?.limits ?? info.limits;

  return {
    maxStorage: limits?.max_storage ?? 0,
    reserved: tier?.reserved_storage ?? info.reserved_storage ?? 0,
    tiered: tier !== undefined,
  };
};

/** Sum of file-backed reservations grouped by replica count. */
const groupByReplicas = (reservations: StreamReservation[]): Map<number, number> => {
  const groups = new Map<number, number>();

  for (const r of reservations) {
    if (r.storage !== StorageType.File) continue;

    const prev = groups.get(r.numReplicas) ?? 0;

    groups.set(r.numReplicas, prev + r.maxBytes * r.numReplicas);
  }

  return groups;
};

/**
 * Opt-in, warn-only storage budget check. Never throws or blocks boot.
 * Heuristic only — server `max_file_store` isn't client-visible and account
 * info is an aggregate, so the wrapped provisioning error stays authoritative.
 *
 * Scoped to file-backed streams (memory streams don't count against file storage)
 * and grouped by replica tier (`R{n}`), since each tier has its own account limit.
 */
export const assertStorageBudget = async (
  jsm: JetStreamManager,
  serviceName: string,
  reservations: StreamReservation[],
  logger: Logger,
): Promise<void> => {
  try {
    const info: AccountInfoView = await jsm.getAccountInfo();
    const groups = groupByReplicas(reservations);

    let limitNotSetWarned = false;
    let okReserved = 0;
    let anyWarned = false;

    for (const [replicas, incremental] of groups) {
      const { maxStorage, reserved, tiered } = resolveTierBudget(info, replicas);
      const tierNote = tiered ? ` (tier R${replicas})` : '';

      if (maxStorage <= 0) {
        if (!limitNotSetWarned) {
          limitNotSetWarned = true;

          logger.warn(
            `Storage preflight for "${serviceName}": account file-storage limit not set ` +
              `(max_storage=${maxStorage}); the server max_file_store cannot be verified from the client.`,
          );
        }

        continue;
      }

      const remaining = maxStorage - reserved;

      if (incremental > remaining) {
        anyWarned = true;

        logger.warn(
          `Storage preflight for "${serviceName}"${tierNote}: needs ~${fmt(incremental)} but only ` +
            `~${fmt(remaining)} remains (reserved ${fmt(reserved)} / limit ${fmt(maxStorage)}). ` +
            `Provisioning will likely fail with insufficient storage. ` +
            `Lower max_bytes/num_replicas, or raise the account/server storage limit.`,
        );

        continue;
      }

      okReserved += incremental;
    }

    if (!anyWarned && !limitNotSetWarned && okReserved > 0) {
      logger.log(
        `Storage preflight for "${serviceName}" OK: reserving ~${fmt(okReserved)} ` +
          `across file-backed streams within account limits.`,
      );
    }
  } catch (err) {
    logger.debug(`Storage preflight skipped — account info unavailable: ${String(err)}`);
  }
};
