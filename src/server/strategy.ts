import { CustomTransportStrategy, Server } from '@nestjs/microservices';

import { ConnectionProvider } from '../connection';
import type { JetstreamModuleOptions, StreamKind } from '../interfaces';

import { CoreRpcServer } from './core-rpc.server';
import { ConsumerProvider, MessageProvider, StreamProvider } from './infrastructure';
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
  ) {
    super();
  }

  /**
   * Start the transport: register handlers, create infrastructure, begin consumption.
   *
   * Called by NestJS when `connectMicroservice()` is used, or internally by the module.
   */
  public async listen(callback: () => void): Promise<void> {
    if (this.started) {
      this.logger.warn('listen() called more than once — ignoring');

      return;
    }

    this.started = true;

    // 1. Register all NestJS handlers
    this.patternRegistry.registerHandlers(this.getHandlers());

    // 2. Determine which stream kinds are needed
    const streamKinds = this.resolveStreamKinds();

    if (streamKinds.length > 0) {
      // 3. Ensure streams exist
      await this.streamProvider.ensureStreams(streamKinds);

      // 4. Ensure consumers exist
      const consumers = await this.consumerProvider.ensureConsumers(streamKinds);

      // 5. Start message consumption
      this.messageProvider.start(consumers);

      // 6. Start event router if needed
      if (this.patternRegistry.hasEventHandlers() || this.patternRegistry.hasBroadcastHandlers()) {
        this.eventRouter.start();
      }

      // 7. Start RPC router if JetStream mode
      if (this.isJetStreamRpcMode() && this.patternRegistry.hasRpcHandlers()) {
        this.rpcRouter.start();
      }
    }

    // 8. Start Core RPC server if core mode
    if (this.isCoreRpcMode() && this.patternRegistry.hasRpcHandlers()) {
      await this.coreRpcServer.start();
    }

    callback();
  }

  /** Stop all consumers, routers, and subscriptions. Called during shutdown. */
  public close(): void {
    this.eventRouter.destroy();
    this.rpcRouter.destroy();
    this.coreRpcServer.stop();
    this.messageProvider.destroy();
    this.started = false;
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

  /** Determine which JetStream stream kinds are needed. */
  private resolveStreamKinds(): StreamKind[] {
    const kinds: StreamKind[] = [];

    if (this.patternRegistry.hasEventHandlers()) {
      kinds.push('ev');
    }

    if (this.isJetStreamRpcMode() && this.patternRegistry.hasRpcHandlers()) {
      kinds.push('cmd');
    }

    if (this.patternRegistry.hasBroadcastHandlers()) {
      kinds.push('broadcast');
    }

    return kinds;
  }

  private isCoreRpcMode(): boolean {
    return !this.options.rpc || this.options.rpc.mode === 'core';
  }

  private isJetStreamRpcMode(): boolean {
    return this.options.rpc?.mode === 'jetstream';
  }
}
