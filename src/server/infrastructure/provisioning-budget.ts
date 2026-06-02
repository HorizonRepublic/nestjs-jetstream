import { type Logger } from '@nestjs/common';
import { type JetStreamManager } from '@nats-io/jetstream';

import { type StreamReservation } from './provisioning-summary';

const GIB = 1024 ** 3;

const fmt = (bytes: number): string => `${(bytes / GIB).toFixed(2)} GiB`;

const dominantReplicas = (reservations: StreamReservation[]): number =>
  reservations.reduce((max, r) => Math.max(max, r.numReplicas), 1);

const incrementalReservation = (reservations: StreamReservation[]): number =>
  reservations.reduce((sum, r) => sum + r.maxBytes * r.numReplicas, 0);

/**
 * Opt-in, warn-only storage budget check. Never throws or blocks boot.
 * Heuristic only — server `max_file_store` isn't client-visible and account
 * info is an aggregate, so the wrapped provisioning error stays authoritative.
 */
export const assertStorageBudget = async (
  jsm: JetStreamManager,
  serviceName: string,
  reservations: StreamReservation[],
  logger: Logger,
): Promise<void> => {
  let info: Awaited<ReturnType<JetStreamManager['getAccountInfo']>>;

  try {
    info = await jsm.getAccountInfo();
  } catch (err) {
    logger.debug(`Storage preflight skipped — getAccountInfo() unavailable: ${String(err)}`);

    return;
  }

  const replicas = dominantReplicas(reservations);
  const tier = info.tiers?.[`R${replicas}`];
  const limits = tier?.limits ?? info.limits;
  const reserved = tier?.reserved_storage ?? info.reserved_storage;
  const maxStorage = limits.max_storage;
  const incremental = incrementalReservation(reservations);
  const tierNote = tier ? ` (tier R${replicas})` : '';

  if (maxStorage <= 0) {
    logger.warn(
      `Storage preflight for "${serviceName}": account file-storage limit not set ` +
        `(max_storage=${maxStorage}); the server max_file_store cannot be verified from the client. ` +
        `This service will reserve ~${fmt(incremental)} (replicas=${replicas}).`,
    );

    return;
  }

  const remaining = maxStorage - reserved;

  if (incremental > remaining) {
    logger.warn(
      `Storage preflight for "${serviceName}": needs ~${fmt(incremental)} but only ~${fmt(remaining)} ` +
        `remains${tierNote} (reserved ${fmt(reserved)} / limit ${fmt(maxStorage)}). ` +
        `Provisioning will likely fail with insufficient storage. ` +
        `Lower max_bytes/num_replicas, or raise the account/server storage limit.`,
    );

    return;
  }

  logger.log(
    `Storage preflight for "${serviceName}" OK: reserving ~${fmt(incremental)}; ` +
      `account${tierNote} reserved ${fmt(reserved)} / limit ${fmt(maxStorage)} (remaining ${fmt(remaining)}).`,
  );
};
