// Module
export { JetstreamModule } from './jetstream.module';

// Interfaces
export { TransportEvent } from './interfaces';

export type {
  Codec,
  JetstreamFeatureOptions,
  JetstreamModuleAsyncOptions,
  JetstreamModuleOptions,
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

// Constants (selective — only what users need)
export {
  getClientToken,
  JetstreamHeader,
  JETSTREAM_CODEC,
  JETSTREAM_CONNECTION,
  JETSTREAM_EVENT_BUS,
  JETSTREAM_OPTIONS,
  nanos,
} from './jetstream.constants';

// Hooks
export { EventBus } from './hooks';

// Server (for advanced use cases)
export { JetstreamStrategy } from './server';
