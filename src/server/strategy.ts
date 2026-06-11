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
 * Coordinates all server-side providers:
 * 1. Registers handlers from NestJS into PatternRegistry
 * 2. Creates required streams and consumers
 * 3. Starts message consumption and routing
 * 4. Handles Core or JetStream RPC based on configuration
 *
 * All dependencies are injected via the NestJS DI container.
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
      // NestJS bridges listen() via a callback — forward errors there so
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
   * Override NestJS `Server.addHandler` to fail-fast on duplicate pattern registration.
   *
   * The base class silently overwrites duplicate RPC handlers (last wins) and appends
   * duplicate event handlers to a linked list. Both behaviors are hazardous in a
   * JetStream context: silent overwrite drops a handler the user wrote, and double
   * event dispatch double-acks/double-processes the same JetStream message.
   *
   * We treat any pattern collision as a fatal misconfiguration so it surfaces at
   * bootstrap instead of in production traffic.
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

  /**
   * Register event listener (required by Server base class).
   *
   * Stores callbacks for client use. Primary lifecycle events
   * are routed through EventBus.
   */
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

    // 1. Register all NestJS handlers
    this.patternRegistry.registerHandlers(this.getHandlers());

    // 2. Determine which streams and durable consumers are needed
    const { streams: streamKinds, durableConsumers: durableKinds } = this.resolveRequiredKinds();

    if (streamKinds.length > 0) {
      // 3. Ensure streams exist
      await this.streamProvider.ensureStreams(streamKinds);

      // 4. Ensure durable consumers exist (ordered consumers are ephemeral — skip)
      let consumers: Map<StreamKind, ConsumerInfo> | null = null;

      if (durableKinds.length > 0) {
        consumers = await this.consumerProvider.ensureConsumers(durableKinds);

        // 5. Populate shared ack_wait map from actual NATS consumer configs
        this.populateAckWaitMap(consumers);

        // 6. Update DLQ thresholds from actual NATS consumer configs
        this.eventRouter.updateMaxDeliverMap(this.buildMaxDeliverMap(consumers));
      }

      // 7. Subscribe routers BEFORE consumption starts — consumers flush their
      // backlog immediately, and a subject with no observers drops messages.
      await this.startRouters();

      // 8. Start durable and ordered message consumption
      await this.startConsumption(consumers);
    }

    // 9. Start Core RPC server if core mode
    if (isCoreRpcMode(this.options.rpc) && this.patternRegistry.hasRpcHandlers()) {
      await this.coreRpcServer.start();
    }

    // 10. Publish handler metadata to KV (non-critical — errors logged, not thrown)
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

    // Ordered consumers are ephemeral — stream only, no durable consumer
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
