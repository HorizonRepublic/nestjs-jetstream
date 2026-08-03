import { Logger } from '@nestjs/common';

import type { ConsumeOptions, ConsumerInfo } from '@nats-io/jetstream';

import { StreamKind } from '../interfaces';
import type {
  Codec,
  DeadLetterConfig,
  EventProcessingConfig,
  ResolvedConnectionOptions,
  RpcRouterOptions,
} from '../interfaces';
import { deriveOtelAttrs, withSelfHealingSpan } from '../otel';
import {
  ConsumerProvider,
  CoreRpcServer,
  EventRouter,
  JetstreamStrategy,
  MessageProvider,
  MetadataProvider,
  PatternRegistry,
  RpcRouter,
  StreamProvider,
  type ConsumerRecoveryFn,
} from '../server';
import { isDlqEnabled } from '../server/infrastructure/dlq-options';
import { InfrastructureBinder } from '../server/infrastructure/infrastructure-binder';
import { NameResolver } from '../server/infrastructure/name-resolver';
import { warnIfManualWithDestructive } from '../server/infrastructure/provisioning-warnings';
import { ConnectionProvider } from './connection.provider';
import type {
  ConnectionBinding,
  ConnectionScope,
  ConnectionSharedContext,
} from './connection.types';

const buildConsumeOptions = (
  options: ResolvedConnectionOptions,
): Map<StreamKind, Partial<ConsumeOptions>> => {
  const map = new Map<StreamKind, Partial<ConsumeOptions>>();

  if (options.events?.consume) map.set(StreamKind.Event, options.events.consume);
  if (options.broadcast?.consume) map.set(StreamKind.Broadcast, options.broadcast.consume);
  if (options.rpc?.mode === 'jetstream' && options.rpc.consume) {
    map.set(StreamKind.Command, options.rpc.consume);
  }

  return map;
};

const buildProcessingConfig = (options: ResolvedConnectionOptions): EventProcessingConfig => ({
  events: {
    concurrency: options.events?.concurrency,
    ackExtension: options.events?.ackExtension,
    retry: options.events?.retry,
  },
  broadcast: {
    concurrency: options.broadcast?.concurrency,
    ackExtension: options.broadcast?.ackExtension,
    retry: options.broadcast?.retry,
  },
});

const buildRpcRouterOptions = (
  options: ResolvedConnectionOptions,
): RpcRouterOptions | undefined => {
  if (options.rpc?.mode !== 'jetstream') return undefined;

  return {
    timeout: options.rpc.timeout,
    concurrency: options.rpc.concurrency,
    ackExtension: options.rpc.ackExtension,
  };
};

/**
 * Build every component one named connection owns.
 *
 * @param options Options for this connection after the root merge.
 * @param shared Application-wide components (event bus, root codec).
 * @param binding Handler-routing context; omitted for single-connection setups.
 */
export const createConnectionScope = (
  options: ResolvedConnectionOptions,
  shared: ConnectionSharedContext,
  binding?: ConnectionBinding | undefined,
): ConnectionScope => {
  const logger = new Logger('Jetstream:Module');
  const { eventBus, rootCodec } = shared;

  const codec: Codec = options.codec ?? rootCodec;
  const connection = new ConnectionProvider(options, eventBus);

  warnIfManualWithDestructive(options, logger);

  const names = new NameResolver(options);
  const ackWaitMap = new Map<StreamKind, number>();

  if (options.consumer === false) {
    return {
      name: options.connectionName,
      critical: options.critical,
      options,
      connection,
      codec,
      names,
      patterns: null,
      binder: null,
      streams: null,
      consumers: null,
      messages: null,
      eventRouter: null,
      rpcRouter: null,
      coreRpc: null,
      metadata: null,
      strategy: null,
      ackWaitMap,
    };
  }

  const patterns = new PatternRegistry(options, names);
  const binder = new InfrastructureBinder(options, names, patterns);
  const streams = new StreamProvider(options, connection, names, binder);
  const consumers = new ConsumerProvider(options, connection, streams, patterns, names, binder);

  const {
    otel,
    serverEndpoint: otelEndpoint,
    serviceName: otelServiceName,
  } = deriveOtelAttrs(options);

  // Recreates the consumer when self-healing hits "consumer not found".
  const consumerRecoveryFn: ConsumerRecoveryFn = async (kind: StreamKind): Promise<ConsumerInfo> =>
    withSelfHealingSpan(
      otel,
      {
        serviceName: otelServiceName,
        endpoint: otelEndpoint,
        consumer: consumers.getConsumerName(kind),
        stream: streams.getStreamName(kind),
        reason: 'consumer not found',
      },
      async () => {
        const jsm = await connection.getJetStreamManager();

        return consumers.recoverConsumer(jsm, kind);
      },
    );

  const messages = new MessageProvider(
    connection,
    eventBus,
    buildConsumeOptions(options),
    consumerRecoveryFn,
  );

  // Dead-letter detection is needed for both capture mechanisms:
  // the DLQ stream (options.dlq) and the onDeadLetter callback.
  const deadLetterConfig: DeadLetterConfig | undefined =
    options.onDeadLetter || isDlqEnabled(options)
      ? { maxDeliverByStream: new Map(), onDeadLetter: options.onDeadLetter }
      : undefined;

  const eventRouter = new EventRouter(
    messages,
    patterns,
    codec,
    eventBus,
    deadLetterConfig,
    buildProcessingConfig(options),
    ackWaitMap,
    connection,
    options,
    names,
  );

  const rpcRouter = new RpcRouter(
    messages,
    patterns,
    connection,
    codec,
    eventBus,
    buildRpcRouterOptions(options),
    ackWaitMap,
    options,
  );

  const coreRpc = new CoreRpcServer(options, connection, patterns, codec, eventBus, names);
  const metadata = new MetadataProvider(options, connection);

  const strategy = new JetstreamStrategy(
    options,
    connection,
    patterns,
    streams,
    consumers,
    messages,
    eventRouter,
    rpcRouter,
    coreRpc,
    ackWaitMap,
    metadata,
    binding,
  );

  return {
    name: options.connectionName,
    critical: options.critical,
    options,
    connection,
    codec,
    names,
    patterns,
    binder,
    streams,
    consumers,
    messages,
    eventRouter,
    rpcRouter,
    coreRpc,
    metadata,
    strategy,
    ackWaitMap,
  };
};
