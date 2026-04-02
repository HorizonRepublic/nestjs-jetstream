import type { StreamConfig } from '@nats-io/jetstream';

export interface StreamConfigChange {
  property: string;
  current: unknown;
  desired: unknown;
  mutability: 'mutable' | 'enable-only' | 'immutable' | 'transport-controlled';
}

export interface StreamConfigDiffResult {
  hasChanges: boolean;
  hasMutableChanges: boolean;
  hasImmutableChanges: boolean;
  hasTransportControlledConflicts: boolean;
  changes: StreamConfigChange[];
}

/**
 * Stream properties controlled by the transport layer (retention policy).
 * A mismatch is always an error — retention is tied to transport semantics
 * (Workqueue for events, Limits for broadcast/ordered) and is never migratable.
 */
const TRANSPORT_CONTROLLED_PROPERTIES = new Set<string>(['retention']);

/**
 * NATS stream properties that cannot be changed after creation,
 * but CAN be migrated via blue-green recreation when allowDestructiveMigration is enabled.
 * Ref: https://docs.nats.io/nats-concepts/jetstream/streams
 * Verified on NATS 2.12.6 via integration test (2026-04-02).
 */
const IMMUTABLE_PROPERTIES = new Set<string>(['storage']);

/**
 * NATS stream properties that can be enabled (false→true) but never disabled.
 * Ref: https://docs.nats.io/nats-concepts/jetstream/streams
 * Verified on NATS 2.12.6 via integration test (2026-04-02).
 */
const ENABLE_ONLY_PROPERTIES = new Set<string>([
  'allow_msg_schedules',
  'allow_msg_ttl',
  'deny_delete',
  'deny_purge',
]);

/**
 * Compare current (from NATS) vs desired (from forRoot config) stream configuration.
 *
 * Classifies each changed property as mutable, enable-only, immutable, or transport-controlled.
 * Only compares properties present in `desired` — server-managed fields in
 * `current` that are absent from `desired` are ignored.
 */
export const compareStreamConfig = (
  current: Partial<StreamConfig>,
  desired: Partial<StreamConfig>,
): StreamConfigDiffResult => {
  const changes: StreamConfigChange[] = [];

  for (const key of Object.keys(desired) as (keyof StreamConfig)[]) {
    const currentVal = current[key];
    const desiredVal = desired[key];

    if (isEqual(currentVal, desiredVal)) continue;

    changes.push({
      property: key,
      current: currentVal,
      desired: desiredVal,
      mutability: classifyMutability(key, currentVal, desiredVal),
    });
  }

  const hasImmutableChanges = changes.some((c) => c.mutability === 'immutable');
  const hasMutableChanges = changes.some(
    (c) => c.mutability === 'mutable' || c.mutability === 'enable-only',
  );
  const hasTransportControlledConflicts = changes.some(
    (c) => c.mutability === 'transport-controlled',
  );

  return {
    hasChanges: changes.length > 0,
    hasMutableChanges,
    hasImmutableChanges,
    hasTransportControlledConflicts,
    changes,
  };
};

const classifyMutability = (
  key: string,
  current: unknown,
  desired: unknown,
): StreamConfigChange['mutability'] => {
  if (TRANSPORT_CONTROLLED_PROPERTIES.has(key)) return 'transport-controlled';
  if (IMMUTABLE_PROPERTIES.has(key)) return 'immutable';

  if (ENABLE_ONLY_PROPERTIES.has(key)) {
    return current === true && desired === false ? 'immutable' : 'enable-only';
  }

  return 'mutable';
};

const isEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a == null && b == null) return true;

  return JSON.stringify(a) === JSON.stringify(b);
};
