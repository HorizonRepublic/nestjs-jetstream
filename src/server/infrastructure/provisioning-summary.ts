import { type RetentionPolicy, StorageType } from '@nats-io/jetstream';

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

/** An externally-managed stream that is bound (not provisioned) by this library. */
export interface ExternalBinding {
  readonly kind: string;
  readonly name: string;
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

/** Operator-facing summary of each stream's storage reservation. Pure — caller logs it. */
export const formatProvisioningSummary = (
  serviceName: string,
  reservations: StreamReservation[],
  external: ExternalBinding[] = [],
): string => {
  const totalStreams = reservations.length + external.length;
  const lines: string[] = [`Provisioning ${totalStreams} stream(s) for "${serviceName}":`];

  let totalFileMaxBytes = 0;

  for (const r of reservations) {
    if (r.storage === StorageType.File) totalFileMaxBytes += r.maxBytes;

    const clusterReservation = r.maxBytes * r.numReplicas;

    lines.push(
      `  • ${r.name} [${r.kind}] storage=${r.storage} replicas=${r.numReplicas} ` +
        `max_bytes=${formatBytes(r.maxBytes)} max_age=${formatAge(r.maxAge)} retention=${r.retention} ` +
        `→ cluster reservation ${formatBytes(clusterReservation)}`,
    );
  }

  for (const e of external) {
    lines.push(`  • ${e.name} [${e.kind}] external (bound)`);
  }

  lines.push(
    `  Σ per-node file-backed footprint ≈ ${formatBytes(totalFileMaxBytes)} ` +
      `(sum of max_bytes; worst case replicas = nodes). ` +
      `Ensure the NATS server max_file_store accommodates the sum across ALL services.`,
  );

  return lines.join('\n');
};
