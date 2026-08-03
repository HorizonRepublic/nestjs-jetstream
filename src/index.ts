// Module
export { JetstreamModule } from './jetstream.module';

// Bootstrap
export { connectJetstreamMicroservices } from './bootstrap';

export type { JetstreamBootstrapOptions } from './bootstrap';

// Interfaces
export { ManagementMode, MessageKind, StreamKind, TransportEvent } from './interfaces';

export type {
  Codec,
  DeadLetterInfo,
  EntityManagement,
  JetstreamConnectionHealth,
  JetstreamConnectionOptions,
  JetstreamFeatureOptions,
  JetstreamHealthStatus,
  JetstreamModuleAsyncOptions,
  JetstreamModuleOptions,
  MetadataRegistryOptions,
  OrderedEventOverrides,
  ProvisioningOptions,
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

// Constants (selective: only what users need)
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
  STREAM_OWNER_METADATA_KEY,
  JETSTREAM_CODEC,
  JETSTREAM_CONNECTION,
  JETSTREAM_CONNECTIONS,
  JETSTREAM_OPTIONS,
  PatternPrefix,
  toNanos,
  metadataKey,
  RESERVED_HEADERS,
  // Default configs: composable building blocks for custom overrides
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

export { JetstreamProvisioningError } from './server/infrastructure/provisioning-error';

// Server (for advanced use cases)
export { JetstreamConnection, JetstreamStrategy } from './server';

// Prometheus metrics
export type { HistogramBuckets, MetricsConfig, MetricsOption } from './metrics/metrics.config';

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
