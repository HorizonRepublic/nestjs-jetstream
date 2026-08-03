import type { EventBus } from '../hooks';
import type { Codec, ResolvedConnectionOptions, StreamKind } from '../interfaces';
import type {
  ConsumerProvider,
  CoreRpcServer,
  EventRouter,
  JetstreamStrategy,
  MessageProvider,
  MetadataProvider,
  PatternRegistry,
  RpcRouter,
  StreamProvider,
} from '../server';
import type { InfrastructureBinder } from '../server/infrastructure/infrastructure-binder';
import type { NameResolver } from '../server/infrastructure/name-resolver';
import type { ConnectionProvider } from './connection.provider';

/** Components shared by every connection in the application. */
export interface ConnectionSharedContext {
  /** One event bus per application; hook events carry the connection name. */
  eventBus: EventBus;

  /** Root-level codec, used when a connection declares none. */
  rootCodec: Codec;
}

/**
 * Everything one named connection owns.
 *
 * Fields are `null` under `consumer: false`, matching what the provider
 * factories already returned in publisher-only mode.
 */
export interface ConnectionScope {
  readonly name: string;
  readonly critical: boolean;
  readonly options: ResolvedConnectionOptions;
  readonly connection: ConnectionProvider;
  readonly codec: Codec;
  readonly names: NameResolver;
  readonly patterns: PatternRegistry | null;
  readonly binder: InfrastructureBinder | null;
  readonly streams: StreamProvider | null;
  readonly consumers: ConsumerProvider | null;
  readonly messages: MessageProvider | null;
  readonly eventRouter: EventRouter | null;
  readonly rpcRouter: RpcRouter | null;
  readonly coreRpc: CoreRpcServer | null;
  readonly metadata: MetadataProvider | null;
  readonly strategy: JetstreamStrategy | null;
  readonly ackWaitMap: Map<StreamKind, number>;
}

/** What a strategy needs to decide whether a handler belongs to it. */
export interface ConnectionBinding {
  /** This strategy's connection name. */
  readonly name: string;

  /** The connection unqualified handlers bind to. */
  readonly defaultName: string;

  /** Every configured connection name. */
  readonly known: ReadonlySet<string>;

  /** Configured connections that cannot host handlers (`consumer: false`). */
  readonly publisherOnly: ReadonlySet<string>;
}
