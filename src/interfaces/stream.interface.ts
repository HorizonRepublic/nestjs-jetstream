/**
 * Identifies a JetStream stream/consumer kind.
 *
 * - `'ev'` — Workqueue events (at-least-once delivery to one consumer).
 * - `'cmd'` — RPC commands (JetStream mode only).
 * - `'broadcast'` — Broadcast events (fan-out to all consumers).
 */
export type StreamKind = 'ev' | 'cmd' | 'broadcast';

/**
 * Subset of {@link StreamKind} used for direct subject building.
 *
 * Excludes `'broadcast'` because broadcast subjects use a different
 * naming convention (`broadcast.{pattern}` instead of `{service}.{kind}.{pattern}`).
 */
export type SubjectKind = Exclude<StreamKind, 'broadcast'>;
