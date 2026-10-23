import { Logger } from '@nestjs/common';

import type { JsMsg } from '@nats-io/jetstream';

import { Observable, Subscription } from 'rxjs';

import { ConnectionProvider } from '../../connection';
import { EventBus } from '../../hooks';
import { StreamKind } from '../../interfaces';
import type {
  RetryConfig,
  AckExtensionConfig,
  Codec,
  DeadLetterConfig,
  EventProcessingConfig,
  JetstreamModuleOptions,
  KindProcessingConfig,
} from '../../interfaces';
import {
  ConsumeKind,
  deriveOtelAttrs,
  resolveOtelOptions,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from '../../otel';
import type { ScheduleStore } from '../../schedule/schedule-store';
import {
  resolveAckExtension,
  resolveRetryDelays,
  startAckExtensionTimer,
} from '../../utils';
import { MessageProvider } from '../infrastructure';
import { NameResolver } from '../infrastructure/name-resolver';
import { ConcurrencyGate } from './concurrency-gate';
import { DeadLetterCapture } from './dead-letter-capture';
import { createOrderedPipeline, createWorkqueuePipeline } from './event-pipeline';
import { PatternRegistry } from './pattern-registry';
import { OrphanOutcome } from './routing.types';
import type {
  EventConsumeKind,
  OrphanTickPolicy,
  ParkTimerFn,
  RoutePipelineContext,
} from './routing.types';

/** Delay before an unhandled tick is offered to another replica. */
const ORPHAN_REDELIVER_DELAY_MS = 5_000;

/** Server and replica clocks may disagree; a holder this close to startup is treated as newer. */
const CLOCK_SKEW_ALLOWANCE_MS = 10_000;

/** Deliveries before an orphan is cancelled when the consumer sets no limit. */
const ORPHAN_FALLBACK_DELIVERIES = 3;

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
  private maxDeliverByStream = new Map<string, number>();
  private readonly startedAt = Date.now();

  public constructor(
    private readonly messageProvider: MessageProvider,
    private readonly patternRegistry: PatternRegistry,
    private readonly codec: Codec,
    private readonly eventBus: EventBus,
    private readonly deadLetterConfig?: DeadLetterConfig | undefined,
    private readonly processingConfig?: EventProcessingConfig | undefined,
    private readonly ackWaitMap?: Map<StreamKind, number> | undefined,
    connection?: ConnectionProvider,
    options?: JetstreamModuleOptions,
    private readonly names?: NameResolver | undefined,
    private readonly scheduleStore?: ScheduleStore | undefined,
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
    this.maxDeliverByStream = consumerMaxDelivers;
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

    if (this.patternRegistry.hasScheduleHandlers()) {
      this.subscribeToStream(this.messageProvider.schedules$, StreamKind.Schedule);
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
    const ackExtension = isOrdered
      ? null
      : resolveAckExtension(this.getAckExtensionConfig(kind), this.ackWaitMap?.get(kind));

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
      ackExtension,
      retryDelays: resolveRetryDelays(this.getRetryConfig(kind)),
      capture: this.capture,
      orphans: kind === StreamKind.Schedule ? this.orphanPolicy() : null,
    };

    const route = isOrdered ? createOrderedPipeline(rctx) : createWorkqueuePipeline(rctx);
    const maxActive = isOrdered ? 1 : (this.getConcurrency(kind) ?? Number.POSITIVE_INFINITY);
    const parkTimer: ParkTimerFn | null =
      ackExtension === null
        ? null
        : (msg): (() => void) | null => startAckExtensionTimer(msg, ackExtension);

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

  private orphanPolicy(): OrphanTickPolicy | null {
    const { scheduleStore, names } = this;

    if (!scheduleStore || !names) return null;

    const stream = names.streamName(StreamKind.Schedule);

    return {
      // An unlimited consumer would hand an orphan around forever; bound it like the default.
      maxDeliver: () => {
        const configured = this.maxDeliverByStream.get(stream) ?? 0;

        return configured > 0 ? configured : ORPHAN_FALLBACK_DELIVERIES;
      },
      redeliverDelayMs: ORPHAN_REDELIVER_DELAY_MS,
      cancelIfOrphaned: async (holderSubject) => {
        const writtenAt = await scheduleStore.writtenAt(holderSubject);

        if (writtenAt === null) return OrphanOutcome.Gone;

        // A replica is never the authority on a schedule written after it started:
        // during a rollout that is a newer replica's schedule, not an orphan.
        if (writtenAt.getTime() > this.startedAt - CLOCK_SKEW_ALLOWANCE_MS) {
          return OrphanOutcome.Newer;
        }

        await scheduleStore.cancel(holderSubject);

        return OrphanOutcome.Cancelled;
      },
    };
  }

  private getRetryConfig(kind: StreamKind): RetryConfig | undefined {
    // Ordered consumers never redeliver, so a curve would have nothing to pace.
    if (kind === StreamKind.Ordered) return false;

    return this.kindConfig(kind)?.retry;
  }

  private getConcurrency(kind: StreamKind): number | undefined {
    return this.kindConfig(kind)?.concurrency;
  }

  private getAckExtensionConfig(kind: StreamKind): AckExtensionConfig | undefined {
    return this.kindConfig(kind)?.ackExtension;
  }

  private kindConfig(kind: StreamKind): KindProcessingConfig | undefined {
    if (kind === StreamKind.Event) return this.processingConfig?.events;
    if (kind === StreamKind.Broadcast) return this.processingConfig?.broadcast;
    if (kind === StreamKind.Schedule) return this.processingConfig?.schedule;

    return undefined;
  }
}
