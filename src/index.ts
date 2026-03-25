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
  OrderedEventOverrides,
  RpcConfig,
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
} from './jetstream.constants';

// Hooks
export { EventBus } from './hooks';

// Server (for advanced use cases)
export { JetstreamStrategy } from './server';
