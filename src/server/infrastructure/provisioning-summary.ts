import { type RetentionPolicy, type StorageType } from '@nats-io/jetstream';

/** One stream's provisioning footprint, used to build the boot summary. */
export interface StreamReservation {
  readonly kind: string;
  readonly name: string;
  readonly storage: StorageType;
  readonly numReplicas: number;
  /** Bytes reserved per replica. */
  readonly maxBytes: number;
  /** Retention age in nanoseconds (0 = unlimited). */
  readonly maxAge: number;
  readonly retention: RetentionPolicy;
}

const GIB = 1024 ** 3;
const NANOS_PER_SECOND = 1e9;
const NANOS_PER_HOUR = 3_600 * NANOS_PER_SECOND;
const NANOS_PER_DAY = 86_400 * NANOS_PER_SECOND;

const formatBytes = (bytes: number): string => {
  if (bytes <= 0) return '0 B';

  return `${(bytes / GIB).toFixed(2)} GiB`;
};

const formatAge = (nanos: number): string => {
  if (nanos <= 0) return 'unlimited';
  if (nanos >= NANOS_PER_DAY) return `${(nanos / NANOS_PER_DAY).toFixed(1)}d`;
  if (nanos >= NANOS_PER_HOUR) return `${(nanos / NANOS_PER_HOUR).toFixed(1)}h`;

  return `${(nanos / NANOS_PER_SECOND).toFixed(0)}s`;
};

/**
 * Build an operator-facing, multi-line summary of what each stream reserves.
 * Pure: no I/O. The caller logs the returned string.
 *
 * Per-stream line shows `max_bytes × num_replicas` = cluster-wide reservation.
 * The total line shows `Σ max_bytes` = per-node footprint in the worst case
 * where replicas = nodes (R = N), which is what exhausts `max_file_store`.
 */
export const formatProvisioningSummary = (
  serviceName: string,
  reservations: StreamReservation[],
): string => {
  const lines: string[] = [`Provisioning ${reservations.length} stream(s) for "${serviceName}":`];

  let totalMaxBytes = 0;

  for (const r of reservations) {
    totalMaxBytes += r.maxBytes;

    const clusterReservation = r.maxBytes * r.numReplicas;

    lines.push(
      `  • ${r.name} [${r.kind}] storage=${r.storage} replicas=${r.numReplicas} ` +
        `max_bytes=${formatBytes(r.maxBytes)} max_age=${formatAge(r.maxAge)} retention=${r.retention} ` +
        `→ cluster reservation ${formatBytes(clusterReservation)}`,
    );
  }

  lines.push(
    `  Σ per-node footprint ≈ ${formatBytes(totalMaxBytes)} ` +
      `(sum of max_bytes; worst case replicas = nodes). ` +
      `Ensure the NATS server max_file_store accommodates the sum across ALL services.`,
  );

  return lines.join('\n');
};
