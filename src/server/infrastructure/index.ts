export { StreamProvider } from './stream.provider';

export { ConsumerProvider } from './consumer.provider';

export { MessageProvider } from './message.provider';

export { MetadataProvider } from './metadata.provider';

export type { ConsumerRecoveryFn } from './message.provider';

export { NatsErrorCode } from './nats-error-codes';

export {
  compareStreamConfig,
  type StreamConfigChange,
  type StreamConfigDiffResult,
} from './stream-config-diff';

export {
  MIGRATION_BACKUP_SUFFIX,
  MIGRATION_HEARTBEAT_KEY,
  MIGRATION_PHASE_KEY,
  StreamMigration,
} from './stream-migration';

export { MigrationPhase, type MigrationTiming } from './stream-migration.types';
