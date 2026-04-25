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
export { JsonCodec, MsgpackCodec } from './codec';

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
  JetstreamDlqHeader,
  dlqStreamName,
  JETSTREAM_CODEC,
  JETSTREAM_CONNECTION,
  JETSTREAM_OPTIONS,
  PatternPrefix,
  toNanos,
  metadataKey,
  RESERVED_HEADERS,
  // Default configs — composable building blocks for custom overrides
  DEFAULT_EVENT_STREAM_CONFIG,
  DEFAULT_COMMAND_STREAM_CONFIG,
  DEFAULT_BROADCAST_STREAM_CONFIG,
  DEFAULT_ORDERED_STREAM_CONFIG,
  DEFAULT_DLQ_STREAM_CONFIG,
  DEFAULT_EVENT_CONSUMER_CONFIG,
  DEFAULT_COMMAND_CONSUMER_CONFIG,
  DEFAULT_BROADCAST_CONSUMER_CONFIG,
  // Default timeouts and metadata-registry settings
  DEFAULT_RPC_TIMEOUT,
  DEFAULT_JETSTREAM_RPC_TIMEOUT,
  DEFAULT_SHUTDOWN_TIMEOUT,
  DEFAULT_METADATA_BUCKET,
  DEFAULT_METADATA_REPLICAS,
  DEFAULT_METADATA_HISTORY,
  DEFAULT_METADATA_TTL,
  MIN_METADATA_TTL,
} from './jetstream.constants';

// Error codes
export { NatsErrorCode } from './server/infrastructure/nats-error-codes';

// Server (for advanced use cases)
export { JetstreamStrategy } from './server';

// OpenTelemetry integration
export { ConsumeKind, DEFAULT_TRACES, JetstreamTrace, PublishKind, TRACER_NAME } from './otel';

export type {
  CaptureBodyOptions,
  ConsumeSourceMsg,
  ErrorClassification,
  HandlerMetadata,
  JetstreamConsumeContext,
  JetstreamPublishContext,
  JetstreamResponseContext,
  OtelOptions,
  ServerEndpoint,
} from './otel';
