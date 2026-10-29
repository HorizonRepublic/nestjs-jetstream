import type { CapabilityErrorReason } from '../connection/server-capabilities.types';
import type { ScheduleErrorReason } from '../schedule/schedule.types';
import type { ProvisioningErrorReason } from '../server/infrastructure/provisioning-error.types';

/** Why the module or a handler declaration was rejected at startup. */
export enum ConfigErrorReason {
  ConnectionsNotStarted = 'connections-not-started',
  SelfTargetPrefix = 'self-target-prefix',
  MetricsRegistryMissing = 'metrics-registry-missing',
  PrometheusClientMissing = 'prometheus-client-missing',
  ForeignRegistry = 'foreign-registry',
  AmbiguousPrometheusClient = 'ambiguous-prometheus-client',
  InvalidAckExtension = 'invalid-ack-extension',
  DuplicateHandler = 'duplicate-handler',
  UnknownConnection = 'unknown-connection',
  PublisherOnlyConnection = 'publisher-only-connection',
  DefaultConnectionRequired = 'default-connection-required',
  DuplicateCluster = 'duplicate-cluster',
  ServersOrConnections = 'servers-or-connections',
  NoConnections = 'no-connections',
  InvalidConnectionName = 'invalid-connection-name',
  NoServers = 'no-servers',
  RemovedOptions = 'removed-options',
  InvalidSubjectPrefix = 'invalid-subject-prefix',
  ConflictingHandlerKinds = 'conflicting-handler-kinds',
  ScheduleOnMessagePattern = 'schedule-on-message-pattern',
  StreamOwnershipConflict = 'stream-ownership-conflict',
  /** The dead-letter stream is turned off or was never created on the connection. */
  DlqUnavailable = 'dlq-unavailable',
}

/** Why the NATS connection was unavailable. */
export enum ConnectionErrorReason {
  NotConnected = 'not-connected',
  ClosedWhileConnecting = 'closed-while-connecting',
  Refused = 'refused',
}

/** Why a record built with `JetstreamRecordBuilder` was rejected. */
export enum RecordErrorReason {
  InvalidScheduleDate = 'invalid-schedule-date',
  ScheduleInPast = 'schedule-in-past',
  InvalidTtl = 'invalid-ttl',
  ReservedNatsHeader = 'reserved-nats-header',
  ReservedTransportHeader = 'reserved-transport-header',
  ScheduleUnsupportedForOrdered = 'schedule-unsupported-for-ordered',
}

/** Why an RPC call or its settlement was rejected. */
export enum RpcErrorReason {
  SettlementConflict = 'settlement-conflict',
  JetStreamOnly = 'jetstream-only',
  DuplicatePublish = 'duplicate-publish',
  Timeout = 'timeout',
  ConnectionLost = 'connection-lost',
  ClientClosed = 'client-closed',
  InboxNotReady = 'inbox-not-ready',
  DecodeFailed = 'decode-failed',
  /** The publish failed in a way the transport did not anticipate; the cause is logged. */
  InternalTransport = 'internal-transport',
}

/** Why externally managed infrastructure does not fit the registered handlers. */
export enum BindingErrorReason {
  ConsumerFilterMismatch = 'consumer-filter-mismatch',
  DlqSubjectMismatch = 'dlq-subject-mismatch',
  ScheduleSubjectMismatch = 'schedule-subject-mismatch',
  ConsumerSwallowsSchedules = 'consumer-swallows-schedules',
  ExternalConsumerAbsent = 'external-consumer-absent',
}

/** Why a destructive stream migration was refused or did not finish. */
export enum MigrationErrorReason {
  TransportConfigConflict = 'transport-config-conflict',
  ScheduleStream = 'schedule-stream',
  SharedStream = 'shared-stream',
  SourcingTimeout = 'sourcing-timeout',
  /** No longer raised: an instance now waits for a live peer migration and takes over an abandoned one. */
  PeerTimeout = 'peer-timeout',
  InProgress = 'in-progress',
  /** The new limits cannot hold the messages the stream already has. */
  InsufficientCapacity = 'insufficient-capacity',
  /** The migrating instance lost its lock to another one and stopped before a destructive step. */
  LockLost = 'lock-lost',
}

/** Why a delivered message could not be handled and went to the dead-letter path. */
export enum DeliveryErrorReason {
  NoHandler = 'no-handler',
  DecodeFailed = 'decode-failed',
  RetryOnFinalAttempt = 'retry-on-final-attempt',
  /** The server stopped redelivering: the handler outlived `ack_wait` or the process stopped. */
  DeliveriesExhausted = 'deliveries-exhausted',
}

/** Why the server rejected a publish. */
export enum PublishErrorReason {
  /** The stream reached `max_msgs`, `max_bytes` or `max_msgs_per_subject` and discards new messages. */
  StreamFull = 'stream-full',
}

/** Every reason a typed transport error can carry. */
export type JetstreamErrorReason =
  | ConfigErrorReason
  | ConnectionErrorReason
  | RecordErrorReason
  | RpcErrorReason
  | BindingErrorReason
  | MigrationErrorReason
  | DeliveryErrorReason
  | PublishErrorReason
  | ScheduleErrorReason
  | ProvisioningErrorReason
  | CapabilityErrorReason;

/** Shape shared by every typed transport error, whichever class it is. */
export interface JetstreamErrorLike extends Error {
  readonly reason: JetstreamErrorReason;
}
