// Module
export { JetstreamModule } from './jetstream.module';

// Interfaces
export { MessageKind, StreamKind, TransportEvent } from './interfaces';

export type {
  Codec,
  DeadLetterInfo,
  JetstreamFeatureOptions,
  JetstreamHealthStatus,
  JetstreamModuleAsyncOptions,
  JetstreamModuleOptions,
  MetadataRegistryOptions,
  OrderedEventOverrides,
  RpcConfig,
  ScheduleRecordOptions,
  StreamConfigOverrides,
  StreamConsumerOverrides,
  TransportHooks,
} from './interfaces';

// Client
export { JetstreamClient } from './client';

export { JetstreamRecord, JetstreamRecordBuilder } from './client';

// Codec
export { JsonCodec } from './codec';

// Context
export { RpcContext } from './context';

// Health
export { JetstreamHealthIndicator } from './health';

// Constants (selective — only what users need)
export {
  streamName,
  buildSubject,
  buildBroadcastSubject,
  consumerName,
  internalName,
  getClientToken,
  isCoreRpcMode,
  isJetStreamRpcMode,
  JetstreamHeader,
  JETSTREAM_CODEC,
  JETSTREAM_CONNECTION,
  JETSTREAM_EVENT_BUS,
  JETSTREAM_OPTIONS,
  PatternPrefix,
  toNanos,
  DEFAULT_METADATA_BUCKET,
  DEFAULT_METADATA_REPLICAS,
  DEFAULT_METADATA_HISTORY,
  DEFAULT_METADATA_TTL,
  metadataKey,
} from './jetstream.constants';

// Hooks
export { EventBus } from './hooks';

// Server (for advanced use cases)
export { JetstreamStrategy } from './server';
