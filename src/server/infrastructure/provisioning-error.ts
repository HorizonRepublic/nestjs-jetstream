import { type JetStreamApiError } from '@nats-io/jetstream';

import { type ProvisioningEntity } from '../../otel';

import { NatsErrorCode } from './nats-error-codes';

/** What was being provisioned when the failure occurred. */
export interface ProvisioningErrorContext {
  readonly entity: ProvisioningEntity;
  readonly name: string;
  readonly kind: string;
  /** Per-replica bytes (streams only). */
  readonly maxBytes?: number;
  /** Replica count (streams only). */
  readonly numReplicas?: number;
}

export interface ProvisioningErrorFields {
  readonly entity: ProvisioningEntity;
  readonly target: string;
  readonly kind: string;
  readonly errCode: number;
  readonly errDescription: string;
  readonly remediation: string;
  readonly maxBytes?: number;
  readonly numReplicas?: number;
  readonly reservation?: number;
  readonly cause: unknown;
}

const REMEDIATION: Partial<Record<NatsErrorCode, string>> = {
  [NatsErrorCode.StorageResourcesExceeded]:
    'Aggregate stream reservation exceeds the server `max_file_store` (or account `max_storage`). ' +
    'Lower `max_bytes`/`num_replicas` for this service, or raise `max_file_store` on the NATS servers.',
  [NatsErrorCode.NoSuitablePeers]:
    'Fewer healthy peers than `num_replicas`, or no peer has enough reserved storage headroom. ' +
    'Reduce replicas or add/repair cluster nodes.',
};

const GENERIC_REMEDIATION =
  'Inspect the NATS server logs and JetStream account limits for the underlying cause.';

/** Non-recoverable stream/consumer provisioning failure; preserves the NATS error as `cause`. */
export class JetstreamProvisioningError extends Error {
  public readonly entity: ProvisioningEntity;
  public readonly target: string;
  public readonly kind: string;
  public readonly errCode: number;
  public readonly errDescription: string;
  public readonly remediation: string;
  public readonly maxBytes?: number;
  public readonly numReplicas?: number;
  public readonly reservation?: number;

  public constructor(fields: ProvisioningErrorFields) {
    const reservationNote =
      fields.reservation !== undefined
        ? ` reservation=${fields.reservation}B (max_bytes=${fields.maxBytes}B x replicas=${fields.numReplicas}).`
        : '';

    super(
      `JetStream ${fields.entity} provisioning failed for "${fields.target}" (kind=${fields.kind}): ` +
        `${fields.errDescription} [err_code=${fields.errCode}].${reservationNote} ${fields.remediation}`,
      { cause: fields.cause },
    );

    this.name = 'JetstreamProvisioningError';
    this.entity = fields.entity;
    this.target = fields.target;
    this.kind = fields.kind;
    this.errCode = fields.errCode;
    this.errDescription = fields.errDescription;
    this.remediation = fields.remediation;
    this.maxBytes = fields.maxBytes;
    this.numReplicas = fields.numReplicas;
    this.reservation = fields.reservation;

    // Keep instanceof working across the dual CJS/ESM build.
    Object.setPrototypeOf(this, JetstreamProvisioningError.prototype);
  }
}

export const mapProvisioningError = (
  err: JetStreamApiError,
  ctx: ProvisioningErrorContext,
): JetstreamProvisioningError => {
  const api = err.apiError();
  const remediation = REMEDIATION[api.err_code as NatsErrorCode] ?? GENERIC_REMEDIATION;
  const reservation =
    ctx.maxBytes !== undefined && ctx.numReplicas !== undefined
      ? ctx.maxBytes * ctx.numReplicas
      : undefined;

  return new JetstreamProvisioningError({
    entity: ctx.entity,
    target: ctx.name,
    kind: ctx.kind,
    errCode: api.err_code,
    errDescription: api.description,
    remediation,
    maxBytes: ctx.maxBytes,
    numReplicas: ctx.numReplicas,
    reservation,
    cause: err,
  });
};
