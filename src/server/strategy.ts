import { CustomTransportStrategy, Server } from '@nestjs/microservices';
import type { MessageHandler, MsPattern } from '@nestjs/microservices';
import type { ConsumerInfo } from '@nats-io/jetstream';

import { ConnectionProvider } from '../connection';
import { StreamKind } from '../interfaces';
import type { JetstreamModuleOptions } from '../interfaces';
import { isCoreRpcMode, isJetStreamRpcMode } from '../jetstream.constants';

import { CoreRpcServer } from './core-rpc.server';
import {
  ConsumerProvider,
  MessageProvider,
  MetadataProvider,
  StreamProvider,
} from './infrastructure';
import { EventRouter, PatternRegistry, RpcRouter } from './routing';

/**
 * NestJS custom transport strategy for NATS JetStream.
 *
 * Registers handlers, provisions streams and consumers, then starts message
 * consumption and routing (Core or JetStream RPC based on configuration).
 */
export class JetstreamStrategy extends Server implements CustomTransportStrategy {
  public readonly transportId = Symbol('jetstream-transport');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private readonly listeners = new Map<string, Function[]>();
  private started = false;

  public constructor(
    private readonly options: JetstreamModuleOptions,
    private readonly connection: ConnectionProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly streamProvider: StreamProvider,
    private readonly consumerProvider: ConsumerProvider,
    private readonly messageProvider: MessageProvider,
    private readonly eventRouter: EventRouter,
    private readonly rpcRouter: RpcRouter,
    private readonly coreRpcServer: CoreRpcServer,
    private readonly ackWaitMap: Map<StreamKind, number> = new Map(),
    private readonly metadataProvider?: MetadataProvider,
  ) {
    super();
  }

  /**
   * Start the transport: register handlers, create infrastructure, begin consumption.
   *
   * Called by NestJS when `connectMicroservice()` is used, or internally by the module.
   */
  public async listen(callback: (...args: unknown[]) => void): Promise<void> {
    try {
      await this.doListen(callback);
    } catch (err) {
      // NestJS bridges listen() via a callback; forward errors there so
      // startAllMicroservices() rejects instead of leaving an unhandled rejection.
      callback(err);
    }
  }

  /** Stop all consumers, routers, subscriptions, and metadata heartbeat. Called during shutdown. */
  public close(): void {
    this.metadataProvider?.destroy();
    this.eventRouter.destroy();
    this.rpcRouter.destroy();
    this.coreRpcServer.stop();
    this.messageProvider.destroy();
    this.started = false;
  }

  /**
   * Override NestJS `Server.addHandler` to fail fast on duplicate pattern registration.
   *
   * The base class silently overwrites duplicate RPC handlers and chains duplicate event
   * handlers, which would double-ack the same JetStream message. Any collision is treated
   * as a fatal misconfiguration so it surfaces at bootstrap, not in production traffic.
   */
  public override addHandler(
    pattern: unknown,
    callback: MessageHandler,
    isEventHandler = false,
    extras: Record<string, unknown> = {},
  ): void {
    const normalizedPattern = this.normalizePattern(pattern as MsPattern);

    if (this.messageHandlers.has(normalizedPattern)) {
      throw new Error(
        `Duplicate handler registered for pattern "${normalizedPattern}". ` +
          `Each @EventPattern() / @MessagePattern() value must be unique within a microservice — ` +
          `find and remove the second declaration.`,
      );
    }

    super.addHandler(pattern, callback, isEventHandler, extras);
  }

  /** Register event listener (required by Server base class); lifecycle events use EventBus. */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  public on(event: string, callback: Function): void {
    const existing = this.listeners.get(event) ?? [];

    existing.push(callback);
    this.listeners.set(event, existing);
  }

  /**
   * Unwrap the underlying NATS connection.
   *
   * @throws Error if the transport has not started.
   */
  public unwrap<T>(): T {
    const nc = this.connection.unwrap;

    if (!nc) {
      throw new Error('Not connected — transport has not started');
    }

    return nc as T;
  }

  /** Access the pattern registry (for module-level introspection). */
  public getPatternRegistry(): PatternRegistry {
    return this.patternRegistry;
  }

  private async doListen(callback: (...args: unknown[]) => void): Promise<void> {
    if (this.started) {
      this.logger.warn('listen() called more than once — ignoring');

      return;
    }

    this.started = true;

    this.patternRegistry.registerHandlers(this.getHandlers());

    const { streams: streamKinds, durableConsumers: durableKinds } = this.resolveRequiredKinds();

    if (streamKinds.length > 0) {
      await this.streamProvider.ensureStreams(streamKinds);

      let consumers: Map<StreamKind, ConsumerInfo> | null = null;

      if (durableKinds.length > 0) {
        consumers = await this.consumerProvider.ensureConsumers(durableKinds);

        this.populateAckWaitMap(consumers);
        this.eventRouter.updateMaxDeliverMap(this.buildMaxDeliverMap(consumers));
      }

      // Routers must subscribe before consumption starts: consumers flush their
      // backlog immediately, and a subject with no observers drops messages.
      await this.startRouters();

      await this.startConsumption(consumers);
    }

    if (isCoreRpcMode(this.options.rpc) && this.patternRegistry.hasRpcHandlers()) {
      await this.coreRpcServer.start();
    }

    if (this.metadataProvider && this.patternRegistry.hasMetadata()) {
      await this.metadataProvider.publish(this.patternRegistry.getMetadataEntries());
    }

    callback();
  }

  /** Determine which streams and durable consumers are needed. */
  private resolveRequiredKinds(): { streams: StreamKind[]; durableConsumers: StreamKind[] } {
    const streams: StreamKind[] = [];
    const durableConsumers: StreamKind[] = [];

    if (this.patternRegistry.hasEventHandlers()) {
      streams.push(StreamKind.Event);
      durableConsumers.push(StreamKind.Event);
    }

    if (isJetStreamRpcMode(this.options.rpc) && this.patternRegistry.hasRpcHandlers()) {
      streams.push(StreamKind.Command);
      durableConsumers.push(StreamKind.Command);
    }

    if (this.patternRegistry.hasBroadcastHandlers()) {
      streams.push(StreamKind.Broadcast);
      durableConsumers.push(StreamKind.Broadcast);
    }

    // Ordered consumers are ephemeral: stream only, no durable consumer
    if (this.patternRegistry.hasOrderedHandlers()) {
      streams.push(StreamKind.Ordered);
    }

    return { streams, durableConsumers };
  }

  /** Subscribe the event and RPC routers to the message subjects. */
  private async startRouters(): Promise<void> {
    if (
      this.patternRegistry.hasEventHandlers() ||
      this.patternRegistry.hasBroadcastHandlers() ||
      this.patternRegistry.hasOrderedHandlers()
    ) {
      this.eventRouter.start();
    }

    if (isJetStreamRpcMode(this.options.rpc) && this.patternRegistry.hasRpcHandlers()) {
      await this.rpcRouter.start();
    }
  }

  /** Begin durable and ordered consumption; routers must already be subscribed. */
  private async startConsumption(consumers: Map<StreamKind, ConsumerInfo> | null): Promise<void> {
    if (consumers !== null) {
      this.messageProvider.start(consumers);
    }

    if (this.patternRegistry.hasOrderedHandlers()) {
      const orderedStreamName = this.streamProvider.getStreamName(StreamKind.Ordered);

      await this.messageProvider.startOrdered(
        orderedStreamName,
        this.patternRegistry.getOrderedSubjects(),
        this.options.ordered,
      );
    }
  }

  private populateAckWaitMap(consumers: Map<StreamKind, ConsumerInfo>): void {
    for (const [kind, info] of consumers) {
      if (info.config.ack_wait) {
        this.ackWaitMap.set(kind, info.config.ack_wait);
      }
    }
  }

  /** Build max_deliver map from actual NATS consumer configs (not options). */
  private buildMaxDeliverMap(consumers: Map<StreamKind, ConsumerInfo>): Map<string, number> {
    const map = new Map<string, number>();

    for (const [, info] of consumers) {
      const stream = info.stream_name;
      const maxDeliver = info.config.max_deliver;

      if (stream && maxDeliver !== undefined && maxDeliver > 0) {
        map.set(stream, maxDeliver);
      }
    }

    return map;
  }
}
