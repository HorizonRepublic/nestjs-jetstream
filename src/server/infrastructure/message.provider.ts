import { Logger } from '@nestjs/common';
import { Consumer, ConsumerInfo, ConsumerMessages, DeliverPolicy, JsMsg } from 'nats';
import type { OrderedConsumerOptions } from 'nats';
import {
  catchError,
  defer,
  EMPTY,
  merge,
  Observable,
  repeat,
  Subject,
  takeUntil,
  tap,
  timer,
} from 'rxjs';

import { ConnectionProvider } from '../../connection';
import { EventBus } from '../../hooks';
import type { OrderedEventOverrides, StreamKind } from '../../interfaces';
import { TransportEvent } from '../../interfaces';

/**
 * Manages pull-based message consumption from JetStream consumers.
 *
 * Uses `defer()` + `repeat()` pattern for self-healing: when the async
 * iterator completes (e.g., NATS restart), the consumer automatically
 * re-establishes after a short delay.
 *
 * Emits messages to kind-specific RxJS subjects for downstream routing.
 */
export class MessageProvider {
  private readonly logger = new Logger('Jetstream:Message');
  private readonly activeIterators = new Set<ConsumerMessages>();
  private orderedReadyResolve: (() => void) | null = null;

  private destroy$ = new Subject<void>();
  private eventMessages$ = new Subject<JsMsg>();
  private commandMessages$ = new Subject<JsMsg>();
  private broadcastMessages$ = new Subject<JsMsg>();
  private orderedMessages$ = new Subject<JsMsg>();

  public constructor(
    private readonly connection: ConnectionProvider,
    private readonly eventBus: EventBus,
  ) {}

  /** Observable stream of workqueue event messages. */
  public get events$(): Observable<JsMsg> {
    return this.eventMessages$.asObservable();
  }

  /** Observable stream of RPC command messages (jetstream mode). */
  public get commands$(): Observable<JsMsg> {
    return this.commandMessages$.asObservable();
  }

  /** Observable stream of broadcast event messages. */
  public get broadcasts$(): Observable<JsMsg> {
    return this.broadcastMessages$.asObservable();
  }

  /** Observable stream of ordered event messages (strict sequential delivery). */
  public get ordered$(): Observable<JsMsg> {
    return this.orderedMessages$.asObservable();
  }

  /**
   * Start consuming messages from the given consumer infos.
   *
   * Each consumer gets an independent self-healing flow.
   * Call `destroy()` to stop all consumers.
   */
  public start(consumers: Map<StreamKind, ConsumerInfo>): void {
    const flows: Observable<void>[] = [];

    for (const [kind, info] of consumers) {
      flows.push(this.createFlow(kind, info));
    }

    if (flows.length > 0) {
      merge(...flows)
        .pipe(takeUntil(this.destroy$))
        .subscribe();
    }
  }

  /**
   * Start an ordered consumer for strict sequential delivery.
   *
   * Unlike durable consumers, ordered consumers are ephemeral — created at
   * consumption time, no durable state. nats.js handles auto-recreation.
   *
   * @param streamName - JetStream stream to consume from.
   * @param filterSubjects - NATS subjects to filter on.
   */
  public async startOrdered(
    streamName: string,
    filterSubjects: string[],
    orderedConfig?: OrderedEventOverrides,
  ): Promise<void> {
    const consumerOpts: Partial<OrderedConsumerOptions> = { filterSubjects };

    // Workaround: nats.js has a bug where explicit DeliverPolicy.All causes consume()
    // to hang (opt_start_seq not deleted). Omitting the field gives the same behavior.
    if (
      orderedConfig?.deliverPolicy !== undefined &&
      orderedConfig.deliverPolicy !== DeliverPolicy.All
    ) {
      consumerOpts.deliver_policy = orderedConfig.deliverPolicy;
    }

    if (orderedConfig?.optStartSeq !== undefined) {
      consumerOpts.opt_start_seq = orderedConfig.optStartSeq;
    }

    if (orderedConfig?.optStartTime !== undefined) {
      consumerOpts.opt_start_time = orderedConfig.optStartTime;
    }

    if (orderedConfig?.replayPolicy !== undefined) {
      consumerOpts.replay_policy = orderedConfig.replayPolicy;
    }

    // Resolve when the ordered consumer is actively consuming (ready for messages)
    const ready = new Promise<void>((resolve) => {
      this.orderedReadyResolve = resolve;
    });

    const flow = this.createOrderedFlow(streamName, consumerOpts);

    flow.pipe(takeUntil(this.destroy$)).subscribe();

    return ready;
  }

  /** Stop all consumer flows and reinitialize subjects for potential restart. */
  public destroy(): void {
    this.destroy$.next();
    this.destroy$.complete();

    for (const messages of this.activeIterators) {
      messages.stop();
    }

    this.activeIterators.clear();

    this.eventMessages$.complete();
    this.commandMessages$.complete();
    this.broadcastMessages$.complete();
    this.orderedMessages$.complete();

    // Reinitialize subjects so start() can be called again after destroy()
    this.destroy$ = new Subject<void>();
    this.eventMessages$ = new Subject<JsMsg>();
    this.commandMessages$ = new Subject<JsMsg>();
    this.broadcastMessages$ = new Subject<JsMsg>();
    this.orderedMessages$ = new Subject<JsMsg>();
  }

  /** Create a self-healing consumer flow for a specific kind. */
  private createFlow(kind: StreamKind, info: ConsumerInfo): Observable<void> {
    const target$ = this.getTargetSubject(kind);
    let consecutiveFailures = 0;
    let lastRunFailed = false;

    return defer(() => this.consumeOnce(info, target$)).pipe(
      tap(() => {
        lastRunFailed = false;
      }),
      catchError((err) => {
        consecutiveFailures++;
        lastRunFailed = true;
        this.logger.error(`Consumer ${info.name} error, will restart:`, err);
        this.eventBus.emit(
          TransportEvent.Error,
          err instanceof Error ? err : new Error(String(err)),
          'message-provider',
        );
        return EMPTY;
      }),
      repeat({
        delay: () => {
          if (!lastRunFailed) {
            consecutiveFailures = 0;
          }

          const delay = Math.min(100 * Math.pow(2, consecutiveFailures), 30_000);

          this.logger.warn(`Consumer ${info.name} stream ended, restarting in ${delay}ms...`);
          return timer(delay);
        },
      }),
      takeUntil(this.destroy$),
    );
  }

  /** Single iteration: get consumer -> pull messages -> emit to subject. */
  private async consumeOnce(info: ConsumerInfo, target$: Subject<JsMsg>): Promise<void> {
    const js = (await this.connection.getConnection()).jetstream();
    const consumer: Consumer = await js.consumers.get(info.stream_name, info.name);
    const messages = await consumer.consume();

    this.activeIterators.add(messages);

    try {
      for await (const msg of messages) {
        target$.next(msg);
      }
    } finally {
      this.activeIterators.delete(messages);
    }
  }

  /** Get the target subject for a consumer kind. */
  private getTargetSubject(kind: StreamKind): Subject<JsMsg> {
    switch (kind) {
      case 'ev':
        return this.eventMessages$;
      case 'cmd':
        return this.commandMessages$;
      case 'broadcast':
        return this.broadcastMessages$;
      case 'ordered':
        return this.orderedMessages$;
    }
  }

  /** Create a self-healing ordered consumer flow. */
  private createOrderedFlow(
    streamName: string,
    consumerOpts: Partial<OrderedConsumerOptions>,
  ): Observable<void> {
    let consecutiveFailures = 0;
    let lastRunFailed = false;

    return defer(() => this.consumeOrderedOnce(streamName, consumerOpts)).pipe(
      tap(() => {
        lastRunFailed = false;
      }),
      catchError((err) => {
        consecutiveFailures++;
        lastRunFailed = true;
        this.logger.error('Ordered consumer error, will restart:', err);
        this.eventBus.emit(
          TransportEvent.Error,
          err instanceof Error ? err : new Error(String(err)),
          'message-provider',
        );
        return EMPTY;
      }),
      repeat({
        delay: () => {
          if (!lastRunFailed) {
            consecutiveFailures = 0;
          }

          const delay = Math.min(100 * Math.pow(2, consecutiveFailures), 30_000);

          this.logger.warn(`Ordered consumer stream ended, restarting in ${delay}ms...`);
          return timer(delay);
        },
      }),
    );
  }

  /** Single iteration: create ordered consumer -> iterate messages. */
  private async consumeOrderedOnce(
    streamName: string,
    consumerOpts: Partial<OrderedConsumerOptions>,
  ): Promise<void> {
    const js = (await this.connection.getConnection()).jetstream();
    const consumer = await js.consumers.get(streamName, consumerOpts);
    const messages = await consumer.consume();

    // Signal that the ordered consumer is ready to receive messages
    if (this.orderedReadyResolve) {
      this.orderedReadyResolve();
      this.orderedReadyResolve = null;
    }

    this.activeIterators.add(messages);

    try {
      for await (const msg of messages) {
        this.orderedMessages$.next(msg);
      }
    } finally {
      this.activeIterators.delete(messages);
    }
  }
}
