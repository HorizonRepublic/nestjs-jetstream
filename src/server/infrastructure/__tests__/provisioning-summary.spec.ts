import { describe, expect, it } from 'vitest';
import { RetentionPolicy, StorageType } from '@nats-io/jetstream';

import { formatProvisioningSummary, type StreamReservation } from '../provisioning-summary';

const GIB = 1024 ** 3;

describe('formatProvisioningSummary', () => {
  // Given: two streams with different replicas
  const reservations: StreamReservation[] = [
    {
      kind: 'ev',
      name: 'svc__microservice_ev-stream',
      storage: StorageType.File,
      numReplicas: 3,
      maxBytes: 5 * GIB,
      maxAge: 7 * 86_400 * 1e9,
      retention: RetentionPolicy.Workqueue,
    },
    {
      kind: 'broadcast',
      name: 'broadcast-stream',
      storage: StorageType.File,
      numReplicas: 3,
      maxBytes: 2 * GIB,
      maxAge: 3_600 * 1e9,
      retention: RetentionPolicy.Limits,
    },
  ];

  it('should list one line per stream with cluster reservation', () => {
    // When
    const result = formatProvisioningSummary('svc', reservations);

    // Then
    expect(result).toContain('svc__microservice_ev-stream [ev]');
    expect(result).toContain('replicas=3');
    expect(result).toContain('max_bytes=5.00 GiB');
    expect(result).toContain('cluster reservation 15.00 GiB'); // 5 × 3
  });

  it('should render a per-node total = sum of max_bytes (worst case replicas=nodes)', () => {
    // When
    const result = formatProvisioningSummary('svc', reservations);

    // Then: 5 + 2 = 7 GiB per node, not 5×3 + 2×3
    expect(result).toContain('per-node footprint ≈ 7.00 GiB');
    expect(result).toContain('max_file_store');
  });

  it('should render zero max_bytes safely', () => {
    // Given: a stream with no byte limit
    const zero: StreamReservation[] = [{ ...reservations[0], maxBytes: 0, maxAge: 0 }];

    // When
    const result = formatProvisioningSummary('svc', zero);

    // Then
    expect(result).toContain('max_bytes=0 B');
    expect(result).toContain('max_age=unlimited');
  });
});
