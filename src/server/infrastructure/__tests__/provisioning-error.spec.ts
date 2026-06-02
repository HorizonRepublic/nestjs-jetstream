import { describe, expect, it } from 'vitest';
import { JetStreamApiError } from '@nats-io/jetstream';

import { NatsErrorCode } from '../nats-error-codes';
import {
  JetstreamProvisioningError,
  mapProvisioningError,
  type ProvisioningErrorContext,
} from '../provisioning-error';

const GIB = 1024 ** 3;

const streamCtx: ProvisioningErrorContext = {
  entity: 'stream',
  name: 'svc__microservice_ev-stream',
  kind: 'ev',
  maxBytes: 5 * GIB,
  numReplicas: 3,
};

describe('mapProvisioningError', () => {
  it('should map insufficient-storage with a max_file_store remediation hint', () => {
    // Given
    const apiErr = new JetStreamApiError({
      err_code: NatsErrorCode.StorageResourcesExceeded,
      code: 500,
      description: 'insufficient storage resources available',
    });

    // When
    const result = mapProvisioningError(apiErr, streamCtx);

    // Then
    expect(result).toBeInstanceOf(JetstreamProvisioningError);
    expect(result.entity).toBe('stream');
    expect(result.target).toBe('svc__microservice_ev-stream');
    expect(result.errCode).toBe(NatsErrorCode.StorageResourcesExceeded);
    expect(result.reservation).toBe(15 * GIB); // 5 × 3
    expect(result.message).toContain('max_file_store');
    expect(result.message).toContain('insufficient storage resources available');
    expect(result.cause).toBe(apiErr);
  });

  it('should map no-suitable-peers with a replicas/peers remediation hint', () => {
    // Given
    const apiErr = new JetStreamApiError({
      err_code: NatsErrorCode.NoSuitablePeers,
      code: 500,
      description: 'no suitable peers for placement',
    });

    // When
    const result = mapProvisioningError(apiErr, streamCtx);

    // Then
    expect(result.message).toContain('peers');
    expect(result.message).toContain('num_replicas');
  });

  it('should map an unknown code with a generic hint, preserving details', () => {
    // Given
    const apiErr = new JetStreamApiError({
      err_code: 10100,
      code: 403,
      description: 'authorization violation',
    });

    // When
    const result = mapProvisioningError(apiErr, streamCtx);

    // Then
    expect(result.errCode).toBe(10100);
    expect(result.message).toContain('authorization violation');
    expect(result.message).toContain('[err_code=10100]');
  });

  it('should omit reservation fields for consumer entities', () => {
    // Given: consumer context has no byte reservation
    const consumerCtx: ProvisioningErrorContext = {
      entity: 'consumer',
      name: 'svc__microservice_ev-consumer',
      kind: 'ev',
    };
    const apiErr = new JetStreamApiError({
      err_code: NatsErrorCode.StorageResourcesExceeded,
      code: 500,
      description: 'insufficient resources',
    });

    // When
    const result = mapProvisioningError(apiErr, consumerCtx);

    // Then
    expect(result.entity).toBe('consumer');
    expect(result.reservation).toBeUndefined();
    expect(result.maxBytes).toBeUndefined();
  });
});
