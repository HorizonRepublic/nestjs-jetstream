/**
 * Identifies a JetStream stream/consumer kind.
 *
 * - `Event`     — Workqueue events (at-least-once delivery to one consumer).
 * - `Command`   — RPC commands (JetStream mode only).
 * - `Broadcast` — Broadcast events (fan-out to all consumers).
 * - `Ordered`   — Ordered events (strict sequential delivery, Limits retention).
 */
export enum StreamKind {
  Event = 'ev',
  Command = 'cmd',
  Broadcast = 'broadcast',
  Ordered = 'ordered',
}

/**
 * Subset of {@link StreamKind} used for direct subject building.
 *
 * Excludes `Broadcast` because broadcast subjects use a different
 * naming convention (`broadcast.{pattern}` instead of `{service}.{kind}.{pattern}`).
 */
export type SubjectKind = Exclude<StreamKind, StreamKind.Broadcast>;
