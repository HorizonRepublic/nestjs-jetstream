import { Logger } from '@nestjs/common';
import type { JsMsg } from '@nats-io/jetstream';
import { Observable, Subscription } from 'rxjs';

import { ConnectionProvider } from '../../connection';
import { EventBus } from '../../hooks';
import { StreamKind } from '../../interfaces';
import type {
  AckExtensionConfig,
  Codec,
  DeadLetterConfig,
  EventProcessingConfig,
  JetstreamModuleOptions,
} from '../../interfaces';
import { resolveAckExtensionInterval, startAckExtensionTimer } from '../../utils';
import {
  ConsumeKind,
  deriveOtelAttrs,
  resolveOtelOptions,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../../otel';

import { MessageProvider } from '../infrastructure';
import { NameResolver } from '../infrastructure/name-resolver';
import { ConcurrencyGate } from './concurrency-gate';
import { DeadLetterCapture } from './dead-letter-capture';
import { createOrderedPipeline, createWorkqueuePipeline } from './event-pipeline';
import { PatternRegistry } from './pattern-registry';
import type { EventConsumeKind, ParkTimerFn, RoutePipelineContext } from './routing.types';

const eventConsumeKindFor = (kind: StreamKind): EventConsumeKind => {
  if (kind === StreamKind.Broadcast) return ConsumeKind.Broadcast;
  if (kind === StreamKind.Ordered) return ConsumeKind.Ordered;

  return ConsumeKind.Event;
};

/**
 * Routes event, broadcast, and ordered messages to their handlers.
 *
 * Per stream kind it assembles a routing pipeline (resolve, handle, settle)
 * and a concurrency gate, then feeds the message stream through them. The
 * dead-letter flow lives in {@link DeadLetterCapture}.
 */
export class EventRouter {
  private readonly logger = new Logger('Jetstream:EventRouter');
  private readonly subscriptions: Subscription[] = [];

  private readonly otel: ResolvedOtelOptions;
  private readonly serviceName: string;
  private readonly serverEndpoint: ServerEndpoint | null;
  private readonly capture: DeadLetterCapture | null;

  public constructor(
    private readonly messageProvider: MessageProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
    private readonly deadLetterConfig?: DeadLetterConfig,
    private readonly processingConfig?: EventProcessingConfig,
    private readonly ackWaitMap?: Map<StreamKind, number>,
    connection?: ConnectionProvider,
    options?: JetstreamModuleOptions,
    names?: NameResolver,
  ) {
    if (options) {
      const derived = deriveOtelAttrs(options);

      this.otel = derived.otel;
      this.serviceName = derived.serviceName;
      this.serverEndpoint = derived.serverEndpoint;
    } else {
      // Unit-test instantiation without options: disable OTel entirely so
      // span helpers short-circuit before reading the placeholder values.
      this.otel = resolveOtelOptions({ enabled: false });
      this.serviceName = '';
      this.serverEndpoint = null;
    }

    this.capture = deadLetterConfig
      ? new DeadLetterCapture(
          patternRegistry,
          eventBus,
          deadLetterConfig,
          this.otel,
          this.serviceName,
          this.serverEndpoint,
          connection,
          options,
          names,
        )
      : null;
  }

  /**
   * Update the max_deliver thresholds from actual NATS consumer configs.
   * Called after consumers are ensured so the DLQ map reflects reality.
   */
  public updateMaxDeliverMap(consumerMaxDelivers: Map<string, number>): void {
    if (!this.deadLetterConfig) return;
    this.deadLetterConfig.maxDeliverByStream = consumerMaxDelivers;
  }

  /** Start routing event, broadcast, and ordered messages to handlers. */
  public start(): void {
    this.subscribeToStream(this.messageProvider.events$, StreamKind.Event);
    this.subscribeToStream(this.messageProvider.broadcasts$, StreamKind.Broadcast);

    if (this.patternRegistry.hasOrderedHandlers()) {
      this.subscribeToStream(this.messageProvider.ordered$, StreamKind.Ordered);
    }
  }

  /** Stop routing and unsubscribe from all streams. */
  public destroy(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }

    this.subscriptions.length = 0;
  }

  /** Assemble the pipeline and concurrency gate for one stream and subscribe. */
  private subscribeToStream(stream$: Observable<JsMsg>, kind: StreamKind): void {
    const isOrdered = kind === StreamKind.Ordered;
    const ackExtensionInterval = isOrdered
      ? null
      : resolveAckExtensionInterval(this.getAckExtensionConfig(kind), this.ackWaitMap?.get(kind));

    const rctx: RoutePipelineContext = {
      kind,
      spanKind: eventConsumeKindFor(kind),
      codec: this.codec,
      logger: this.logger,
      eventBus: this.eventBus,
      patternRegistry: this.patternRegistry,
      otel: this.otel,
      serviceName: this.serviceName,
      serverEndpoint: this.serverEndpoint,
      ackExtensionInterval,
      capture: this.capture,
    };

    const route = isOrdered ? createOrderedPipeline(rctx) : createWorkqueuePipeline(rctx);
    const maxActive = isOrdered ? 1 : (this.getConcurrency(kind) ?? Number.POSITIVE_INFINITY);
    const hasAckExtension = ackExtensionInterval !== null && ackExtensionInterval > 0;
    const parkTimer: ParkTimerFn | null = hasAckExtension
      ? (msg): (() => void) | null => startAckExtensionTimer(msg, ackExtensionInterval)
      : null;

    const gate = new ConcurrencyGate(maxActive, route, parkTimer, this.logger, kind);

    const subscription = stream$.subscribe({
      next: (msg: JsMsg): void => {
        gate.push(msg);
      },
      error: (err: unknown): void => {
        this.logger.error(`Stream error in ${kind} router`, err);
      },
    });

    subscription.add(() => {
      gate.dispose();
    });

    this.subscriptions.push(subscription);
  }

  private getConcurrency(kind: StreamKind): number | undefined {
    if (kind === StreamKind.Event) return this.processingConfig?.events?.concurrency;
    if (kind === StreamKind.Broadcast) return this.processingConfig?.broadcast?.concurrency;

    return undefined;
  }

  private getAckExtensionConfig(kind: StreamKind): AckExtensionConfig | undefined {
    if (kind === StreamKind.Event) return this.processingConfig?.events?.ackExtension;
    if (kind === StreamKind.Broadcast) return this.processingConfig?.broadcast?.ackExtension;

    return undefined;
  }
}
