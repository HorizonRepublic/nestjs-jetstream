import { describe, expect, it } from 'vitest';
import { RetentionPolicy, StorageType } from '@nats-io/jetstream';

import { StreamKind } from '../../../interfaces';
import {
  formatProvisioningSummary,
  type ExternalBinding,
  type StreamReservation,
} from '../provisioning-summary';

const GIB = 1024 ** 3;

describe('formatProvisioningSummary', () => {
  // Given: two streams with different replicas
  const reservations: StreamReservation[] = [
    {
      kind: StreamKind.Event,
      name: 'svc__microservice_ev-stream',
      storage: StorageType.File,
      numReplicas: 3,
      maxBytes: 5 * GIB,
      maxAge: 7 * 86_400 * 1e9,
      retention: RetentionPolicy.Workqueue,
    },
    {
      kind: StreamKind.Broadcast,
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
    expect(result).toContain('per-node file-backed footprint ≈ 7.00 GiB');
    expect(result).toContain('max_file_store');
  });

  it('should exclude memory-backed streams from the file-backed footprint total', () => {
    // Given: one file stream (2 GiB) + one memory stream (3 GiB)
    const mixed: StreamReservation[] = [
      {
        kind: StreamKind.Event,
        name: 'svc__microservice_ev-stream',
        storage: StorageType.File,
        numReplicas: 1,
        maxBytes: 2 * GIB,
        maxAge: 0,
        retention: RetentionPolicy.Limits,
      },
      {
        kind: StreamKind.Broadcast,
        name: 'broadcast-stream',
        storage: StorageType.Memory,
        numReplicas: 1,
        maxBytes: 3 * GIB,
        maxAge: 0,
        retention: RetentionPolicy.Limits,
      },
    ];

    // When
    const result = formatProvisioningSummary('svc', mixed);

    // Then: only the file-backed 2 GiB counts toward the footer total
    expect(result).toContain('per-node file-backed footprint ≈ 2.00 GiB');
  });

  it('should render zero max_bytes safely', () => {
    // Given: a stream with no byte limit
    const zero: StreamReservation[] = [
      {
        kind: StreamKind.Event,
        name: 'svc__microservice_ev-stream',
        storage: StorageType.File,
        numReplicas: 3,
        maxBytes: 0,
        maxAge: 0,
        retention: RetentionPolicy.Workqueue,
      },
    ];

    // When
    const result = formatProvisioningSummary('svc', zero);

    // Then
    expect(result).toContain('max_bytes=0 B');
    expect(result).toContain('max_age=unlimited');
  });

  describe('external bindings', () => {
    const external: ExternalBinding[] = [
      { kind: StreamKind.Event, name: 'acme__microservice_ev-stream' },
      { kind: 'dlq', name: 'acme__microservice_dlq-stream' },
    ];

    it('should render external rows with an "external (bound)" marker', () => {
      // When
      const result = formatProvisioningSummary('acme', [], external);

      // Then
      expect(result).toContain('acme__microservice_ev-stream');
      expect(result).toContain('external (bound)');
    });

    it('should not include external rows in the file-backed footprint total', () => {
      // Given: one Auto reservation + two external bindings
      const auto: StreamReservation[] = [
        {
          kind: StreamKind.Broadcast,
          name: 'broadcast-stream',
          storage: StorageType.File,
          numReplicas: 1,
          maxBytes: 2 * GIB,
          maxAge: 0,
          retention: RetentionPolicy.Limits,
        },
      ];

      // When
      const result = formatProvisioningSummary('acme', auto, external);

      // Then: totals only include the auto broadcast stream (2 GiB), not externals
      expect(result).toContain('per-node file-backed footprint ≈ 2.00 GiB');
    });

    it('should count both auto and external rows in the header stream count', () => {
      // When: 0 auto + 2 external
      const result = formatProvisioningSummary('acme', [], external);

      // Then: header says 2 stream(s) — the externals count as streams for operator visibility
      expect(result).toContain('2 stream(s)');
    });

    it('should work when external list is omitted (backward-compatible default)', () => {
      // When: no third argument
      const result = formatProvisioningSummary('svc', reservations);

      // Then: existing tests remain valid — no crash, no "external" text
      expect(result).not.toContain('external');
    });
  });
});
