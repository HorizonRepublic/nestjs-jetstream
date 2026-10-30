import { Logger } from '@nestjs/common';

import type { JsMsg } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { Subscription } from 'rxjs';

import { ConnectionProvider } from '../../connection';
import { EventBus } from '../../hooks';
import { StreamKind } from '../../interfaces';
import type { Codec, JetstreamModuleOptions, RpcRouterOptions } from '../../interfaces';
import { DEFAULT_JETSTREAM_RPC_TIMEOUT } from '../../jetstream.constants';
import {
  deriveOtelAttrs,
  resolveOtelOptions,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../../otel';
import {
  handlerRunLimit,
  resolveAckExtension,
  resolveParkExtension,
  startAckExtensionTimer,
  type AckExtension,
} from '../../utils';
import { MessageProvider } from '../infrastructure';
import { ConcurrencyGate } from './concurrency-gate';
import type { FinalDeliveries } from './final-deliveries';
import { InFlightTracker } from './in-flight-tracker';
import { PatternRegistry } from './pattern-registry';
import type { ParkTimerFn, RouteFn } from './routing.types';
import { createRpcPipeline } from './rpc-pipeline';

/**
 * Routes RPC command messages in JetStream mode.
 *
 * Delivery semantics:
 * - Handler must complete within timeout (default: 3 min)
 * - Success -> ack -> publish response to ReplyTo (publish failure does not affect ack)
 * - Handler error -> publish error to ReplyTo -> term (no redelivery)
 * - Timeout -> no response -> term
 * - No handler / decode error -> term immediately
 *
 * Nak is never used for RPC; it would risk duplicate side effects.
 */
export class RpcRouter {
  private readonly logger = new Logger('Jetstream:RpcRouter');
  private readonly timeout: number;
  private readonly concurrency: number | undefined;
  private resolvedAckExtension: AckExtension | null | undefined;
  private subscription: Subscription | null = null;
  private cachedNc: NatsConnection | null = null;
  private readonly inFlight = new InFlightTracker();

  private readonly otel: ResolvedOtelOptions;
  private readonly serviceName: string;
  private readonly serverEndpoint: ServerEndpoint | null;

  public constructor(
    private readonly messageProvider: MessageProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly connection: ConnectionProvider,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
    private readonly rpcOptions?: RpcRouterOptions | undefined,
    private readonly ackWaitMap?: Map<StreamKind, number> | undefined,
    options?: JetstreamModuleOptions,
    private readonly finalDeliveries?: FinalDeliveries | null | undefined,
  ) {
    this.timeout = rpcOptions?.timeout ?? DEFAULT_JETSTREAM_RPC_TIMEOUT;
    this.concurrency = rpcOptions?.concurrency;
    if (options) {
      const derived = deriveOtelAttrs(options);

      this.otel = derived.otel;
      this.serviceName = derived.serviceName;
      this.serverEndpoint = derived.serverEndpoint;
    } else {
      // Unit-test instantiation without options: disable OTel entirely
      // so span helpers short-circuit on `config.enabled` before touching
      // the placeholder values. See EventRouter for the same pattern.
      this.otel = resolveOtelOptions({ enabled: false });
      this.serviceName = '';
      this.serverEndpoint = null;
    }
  }

  /** Lazily resolve the ack extension (needs ackWaitMap populated at runtime). */
  private get ackExtension(): AckExtension | null {
    if (this.resolvedAckExtension !== undefined) return this.resolvedAckExtension;
    this.resolvedAckExtension = resolveAckExtension(
      this.rpcOptions?.ackExtension,
      this.ackWaitMap?.get(StreamKind.Command),
    );
    return this.resolvedAckExtension;
  }

  /** Start routing command messages to handlers. */
  public async start(): Promise<void> {
    this.cachedNc = await this.connection.getConnection();
    // A second start replaces the subscription instead of leaking the first one.
    this.destroy();

    const logger = this.logger;
    const ackExtension = this.ackExtension;
    const maxActive = this.concurrency ?? Number.POSITIVE_INFINITY;

    const pipeline = createRpcPipeline({
      nc: this.cachedNc,
      codec: this.codec,
      logger,
      eventBus: this.eventBus,
      patternRegistry: this.patternRegistry,
      otel: this.otel,
      serviceName: this.serviceName,
      serverEndpoint: this.serverEndpoint,
      ackExtension,
      timeout: this.timeout,
    });
    const runLimit = handlerRunLimit(ackExtension);
    const handleSafe: RouteFn = (msg) => {
      const pending = pipeline(msg);

      if (pending !== undefined) {
        this.inFlight.track(pending);
        this.finalDeliveries?.track(msg, pending, runLimit);
      }

      return pending;
    };

    const parkExtension = resolveParkExtension(
      ackExtension,
      this.ackWaitMap?.get(StreamKind.Command),
    );
    const parkTimer: ParkTimerFn = (msg) => startAckExtensionTimer(msg, parkExtension);
    const gate = new ConcurrencyGate(maxActive, handleSafe, parkTimer, logger, 'RPC');

    this.subscription = this.messageProvider.commands$.subscribe({
      next: (msg: JsMsg): void => {
        gate.push(msg);
      },
      error: (err: unknown): void => {
        logger.error('Stream error in RPC router', err);
      },
    });

    this.subscription.add(() => {
      gate.dispose();
    });
  }

  /**
   * Resolve once every command already routed has been settled and answered,
   * or abandoned at its deadline.
   */
  public async whenIdle(): Promise<void> {
    await this.inFlight.whenIdle();
  }

  /** Stop routing and unsubscribe; commands already running still settle and reply. */
  public destroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }
}
