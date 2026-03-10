import { Logger } from '@nestjs/common';
import { Msg, Subscription } from 'nats';

import { ConnectionProvider } from '../connection';
import { RpcContext } from '../context';
import { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';
import type { Codec, JetstreamModuleOptions } from '../interfaces';
import { internalName } from '../jetstream.constants';
import { unwrapResult } from '../utils';

import { PatternRegistry } from './routing/pattern-registry';

/**
 * Handles RPC via NATS Core request/reply pattern.
 *
 * Subscribes to `{service}.cmd.>` with a queue group for load balancing.
 * Each request is processed and replied to directly via `msg.respond()`.
 *
 * This is the default RPC mode — lowest latency, no persistence overhead.
 */
export class CoreRpcServer {
  private readonly logger = new Logger(CoreRpcServer.name);
  private subscription: Subscription | null = null;

  public constructor(
    private readonly options: JetstreamModuleOptions,
    private readonly connection: ConnectionProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
  ) {}

  /** Start listening for RPC requests on the command subject. */
  public async start(): Promise<void> {
    const nc = await this.connection.getConnection();
    const serviceName = internalName(this.options.name);
    const subject = `${serviceName}.cmd.>`;
    const queue = `${serviceName}_cmd_queue`;

    this.subscription = nc.subscribe(subject, {
      queue,
      callback: (err, msg) => {
        if (err) {
          this.logger.error('Core RPC subscription error:', err);
          return;
        }

        this.handleRequest(msg).catch((err) => {
          this.logger.error('Unhandled request error:', err);
        });
      },
    });

    this.logger.log(`Core RPC listening: ${subject} (queue: ${queue})`);
  }

  /** Stop listening and clean up the subscription. */
  public stop(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  /** Handle an incoming Core NATS request. */
  private async handleRequest(msg: Msg): Promise<void> {
    const handler = this.patternRegistry.getHandler(msg.subject);

    if (!handler) {
      this.logger.warn(`No handler for Core RPC: ${msg.subject}`);
      // No handler — don't respond, let client timeout
      return;
    }

    this.eventBus.emit(TransportEvent.MessageRouted, msg.subject, 'rpc');

    let data: unknown;

    try {
      data = this.codec.decode(msg.data);
    } catch (err) {
      this.logger.error(`Decode error for Core RPC ${msg.subject}:`, err);
      this.respondWithError(msg, err);
      return;
    }

    const ctx = new RpcContext([msg]);

    try {
      const result = await unwrapResult(handler(data, ctx));

      msg.respond(this.codec.encode(result));
    } catch (err) {
      this.logger.error(`Handler error for Core RPC ${msg.subject}:`, err);
      this.respondWithError(msg, err);
    }
  }

  /** Send an error response back to the caller. */
  private respondWithError(msg: Msg, error: unknown): void {
    try {
      msg.respond(
        this.codec.encode({ error: error instanceof Error ? error.message : String(error) }),
      );
    } catch {
      this.logger.error('Failed to encode error response');
    }
  }
}
