import { Logger } from '@nestjs/common';
import { headers as natsHeaders, type Msg, type Subscription } from '@nats-io/transport-node';

import { ConnectionProvider } from '../connection';
import { RpcContext } from '../context';
import { EventBus } from '../hooks';
import { MessageKind, TransportEvent } from '../interfaces';
import type { Codec, JetstreamModuleOptions } from '../interfaces';
import { JetstreamHeader } from '../jetstream.constants';
import {
  ConsumeKind,
  deriveOtelAttrs,
  withConsumeSpan,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../otel';
import { isPromiseLike, serializeError, unwrapResult } from '../utils';

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
  private readonly logger = new Logger('Jetstream:CoreRpc');
  private subscription: Subscription | null = null;

  private readonly otel: ResolvedOtelOptions;
  private readonly serviceName: string;
  private readonly serverEndpoint: ServerEndpoint | null;

  public constructor(
    options: JetstreamModuleOptions,
    private readonly connection: ConnectionProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
  ) {
    const derived = deriveOtelAttrs(options);

    this.otel = derived.otel;
    this.serviceName = derived.serviceName;
    this.serverEndpoint = derived.serverEndpoint;
  }

  /** Start listening for RPC requests on the command subject. */
  public async start(): Promise<void> {
    const nc = await this.connection.getConnection();
    const subject = `${this.serviceName}.cmd.>`;
    const queue = `${this.serviceName}_cmd_queue`;

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
    if (!msg.reply) {
      this.logger.warn(`Ignoring fire-and-forget message on RPC subject: ${msg.subject}`);
      return;
    }

    const handler = this.patternRegistry.getHandler(msg.subject);

    if (!handler) {
      this.logger.warn(`No handler for Core RPC: ${msg.subject}`);
      this.respondWithError(msg, new Error(`No handler for subject: ${msg.subject}`));
      return;
    }

    this.eventBus.emitMessageRouted(msg.subject, MessageKind.Rpc);

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
      const raw = await withConsumeSpan(
        {
          subject: msg.subject,
          msg,
          kind: ConsumeKind.Rpc,
          payloadBytes: msg.data.length,
          handlerMetadata: { pattern: msg.subject },
          serviceName: this.serviceName,
          endpoint: this.serverEndpoint,
        },
        this.otel,
        () => {
          const out = unwrapResult(handler(data, ctx));

          return isPromiseLike(out) ? (out as Promise<unknown>) : out;
        },
      );

      msg.respond(this.codec.encode(raw));
    } catch (err) {
      this.eventBus.emit(
        TransportEvent.Error,
        err instanceof Error ? err : new Error(String(err)),
        `core-rpc-handler:${msg.subject}`,
      );
      this.respondWithError(msg, err);
    }
  }

  /** Send an error response back to the caller with x-error header. */
  private respondWithError(msg: Msg, error: unknown): void {
    try {
      const hdrs = natsHeaders();

      hdrs.set(JetstreamHeader.Error, 'true');
      msg.respond(this.codec.encode(serializeError(error)), { headers: hdrs });
    } catch {
      this.logger.error('Failed to encode error response');
    }
  }
}
