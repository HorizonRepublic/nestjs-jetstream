/** How far a migration got, as its owner last recorded it on the backup. */
export enum MigrationPhase {
  /** The original stream still exists; the backup is a copy in progress. */
  Backup = 'backup',
  /** The original was deleted; the backup holds the only copy until it is restored. */
  Restore = 'restore',
}

/** Migration timing. Production uses the defaults; tests shorten them. */
export interface MigrationTiming {
  /** How often the migrating instance proves it is still alive. */
  readonly heartbeatIntervalMs: number;
  /** How long another instance must see no heartbeat before it takes the migration over. */
  readonly abandonedAfterMs: number;
  /** How long sourcing may make no progress before the migration fails. */
  readonly stallTimeoutMs: number;
}
