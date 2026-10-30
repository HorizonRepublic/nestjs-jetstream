import { Logger } from '@nestjs/common';

import type {
  ConsumeOptions,
  Consumer,
  ConsumerInfo,
  ConsumerMessages,
  JsMsg,
  OrderedConsumerOptions,
} from '@nats-io/jetstream';
import { DeliverPolicy } from '@nats-io/jetstream';

import {
  catchError,
  defer,
  EMPTY,
  merge,
  Observable,
  race,
  repeat,
  Subject,
  take,
  takeUntil,
  tap,
  timer,
} from 'rxjs';

import { ConnectionProvider } from '../../connection';
import { EventBus } from '../../hooks';
import type { OrderedEventOverrides } from '../../interfaces';
import { StreamKind, TransportEvent } from '../../interfaces';
import { errorMessage, toError } from '../../utils';
import type { ConsumerFlowState } from './consumer-flow.types';
import type { ConsumerRecoveryFn } from './message.provider.types';
import { NatsErrorCode } from './nats-error-codes';

/**
 * How often a broadcast consumer's position is re-read, so a recreated durable
 * resumes close to where the vanished one stopped instead of replaying history.
 */
const POSITION_REFRESH_MS = 10_000;

/** The consumer a flow consumes from, as last read from the server. */
interface FlowPosition {
  info: ConsumerInfo;
}

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
  private readonly flowStates = new Map<StreamKind, ConsumerFlowState>();
  private orderedReadyResolve: (() => void) | null = null;
  private orderedReadyReject: ((err: unknown) => void) | null = null;

  private destroy$ = new Subject<void>();
  private eventMessages$ = new Subject<JsMsg>();
  private commandMessages$ = new Subject<JsMsg>();
  private broadcastMessages$ = new Subject<JsMsg>();
  private orderedMessages$ = new Subject<JsMsg>();
  private scheduleMessages$ = new Subject<JsMsg>();

  public constructor(
    private readonly connection: ConnectionProvider,
    private readonly eventBus: EventBus,
    private readonly consumeOptionsMap: Map<StreamKind, Partial<ConsumeOptions>> = new Map(),
    private readonly consumerRecoveryFn?: ConsumerRecoveryFn | undefined,
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

  /** Observable stream of schedule ticks. */
  public get schedules$(): Observable<JsMsg> {
    return this.scheduleMessages$.asObservable();
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
   * Unlike durable consumers, ordered consumers are ephemeral: created at
   * consumption time and forgotten afterwards. nats.js handles auto-recreation.
   *
   * @param streamName - JetStream stream to consume from.
   * @param filterSubjects - NATS subjects to filter on.
   * @param orderedConfig - Optional overrides for ordered consumer options.
   */
  public async startOrdered(
    streamName: string,
    filterSubjects: string[],
    orderedConfig?: OrderedEventOverrides,
  ): Promise<void> {
    const { deliver_policy: deliverPolicy, ...rest } = orderedConfig?.consumer ?? {};

    const consumerOpts: Partial<OrderedConsumerOptions> = {
      ...rest,
      filter_subjects: filterSubjects,
    };

    // Workaround: in nats.js (v2.29.x), explicitly passing DeliverPolicy.All to an
    // ordered consumer leaves opt_start_seq in the config, causing consume() to hang.
    // Omitting deliver_policy lets nats.js use its internal default (same All behavior).
    // See: nats.js/lib/jetstream/consumer.js, OrderedPullConsumerImpl.resetConsumer()
    if (deliverPolicy !== undefined && deliverPolicy !== DeliverPolicy.All) {
      consumerOpts.deliver_policy = deliverPolicy;
    }

    // Resolve/reject when the ordered consumer connects or fails on first attempt
    const ready = new Promise<void>((resolve, reject) => {
      this.orderedReadyResolve = resolve;
      this.orderedReadyReject = reject;
    });

    const flow = this.createOrderedFlow(streamName, consumerOpts);

    flow.pipe(takeUntil(this.destroy$)).subscribe();

    return ready;
  }

  /** A copy of every running flow's state, for health reporting. */
  public getFlowStates(): ConsumerFlowState[] {
    return [...this.flowStates.values()].map((state) => ({ ...state }));
  }

  /** Stop all consumer flows and reinitialize subjects for potential restart. */
  public destroy(): void {
    // Reject pending ordered consumer ready promise to unblock listen()
    if (this.orderedReadyReject) {
      this.orderedReadyReject(new Error('Destroyed before ordered consumer connected'));
      this.orderedReadyResolve = null;
      this.orderedReadyReject = null;
    }

    this.destroy$.next();
    this.destroy$.complete();

    for (const messages of this.activeIterators) {
      messages.stop();
    }

    this.activeIterators.clear();
    this.flowStates.clear();

    this.eventMessages$.complete();
    this.commandMessages$.complete();
    this.broadcastMessages$.complete();
    this.orderedMessages$.complete();
    this.scheduleMessages$.complete();

    // Reinitialize subjects so start() can be called again after destroy()
    this.destroy$ = new Subject<void>();
    this.eventMessages$ = new Subject<JsMsg>();
    this.commandMessages$ = new Subject<JsMsg>();
    this.broadcastMessages$ = new Subject<JsMsg>();
    this.orderedMessages$ = new Subject<JsMsg>();
    this.scheduleMessages$ = new Subject<JsMsg>();
  }

  /** Create a self-healing consumer flow for a specific kind. */
  private createFlow(kind: StreamKind, info: ConsumerInfo): Observable<void> {
    const target$ = this.getTargetSubject(kind);
    const position: FlowPosition = { info };

    return this.createSelfHealingFlow(
      (onConnected) => this.consumeOnce(kind, position, target$, onConnected),
      info.name,
      this.trackFlow(kind, info.name),
    );
  }

  /** Single iteration: get consumer -> pull messages -> emit to subject. */
  private async consumeOnce(
    kind: StreamKind,
    position: FlowPosition,
    target$: Subject<JsMsg>,
    onConnected: () => void,
  ): Promise<void> {
    const js = this.connection.getJetStreamClient();
    const { info } = position;

    let consumer: Consumer;
    let consumerName = info.name;

    try {
      consumer = await js.consumers.get(info.stream_name, info.name);
    } catch (err) {
      if (this.isConsumerNotFound(err) && this.consumerRecoveryFn) {
        this.logger.warn(`Consumer ${info.name} not found, recreating...`);
        const recovered = await this.consumerRecoveryFn(kind, info);

        position.info = recovered;
        consumerName = recovered.name;
        this.logger.log(`Consumer ${consumerName} recreated, resuming consumption`);
        consumer = await js.consumers.get(recovered.stream_name, consumerName);
      } else {
        throw err;
      }
    }

    const defaults: Partial<ConsumeOptions> = { idle_heartbeat: 5_000 };
    const userOptions = this.consumeOptionsMap.get(kind) ?? {};

    // Push messages directly into the subject via a sync callback so each
    // delivery skips the async-iterator next()/{value,done} wrapper allocated
    // by `for await`. The callback path in @nats-io/jetstream requires the
    // body to be synchronous; `Subject.next` meets that contract.
    const messages = await consumer.consume({
      ...defaults,
      ...userOptions,
      callback: (msg: JsMsg): void => {
        target$.next(msg);
      },
    } as ConsumeOptions);

    this.activeIterators.add(messages);
    this.monitorConsumerHealth(messages, consumerName);
    // Signal recovery now: consume() succeeded, the consumer is live.
    // Doing it after `await messages.closed()` would log "recovered" only
    // when the stream ends, which is the wrong moment.
    onConnected();

    const refresh = kind === StreamKind.Broadcast ? this.trackPosition(consumer, position) : null;

    try {
      await messages.closed();
    } finally {
      if (refresh !== null) clearInterval(refresh);
      this.activeIterators.delete(messages);
    }
  }

  /** Keep the consumer's ack floor fresh while it consumes; a failed read keeps the last one. */
  private trackPosition(
    consumer: Consumer,
    position: FlowPosition,
  ): ReturnType<typeof setInterval> {
    const refresh = setInterval(() => {
      consumer.info().then(
        (info) => {
          position.info = info;
        },
        (err: unknown) => {
          this.logger.debug(`Consumer ${position.info.name}: position refresh failed`, err);
        },
      );
    }, POSITION_REFRESH_MS);

    refresh.unref();

    return refresh;
  }

  /**
   * Detect "consumer not found" errors from `js.consumers.get()`.
   *
   * Unlike JetStream Manager calls (which throw `JetStreamApiError`),
   * the JetStream client's `consumers.get()` throws a plain `Error`
   * with the error code embedded in the message text.
   */
  private isConsumerNotFound(err: unknown): boolean {
    if (!(err instanceof Error)) return false;

    return (
      err.message.includes('consumer not found') ||
      err.message.includes(String(NatsErrorCode.ConsumerNotFound))
    );
  }

  /** Get the target subject for a consumer kind. */
  private getTargetSubject(kind: StreamKind): Subject<JsMsg> {
    switch (kind) {
      case StreamKind.Event:
        return this.eventMessages$;
      case StreamKind.Command:
        return this.commandMessages$;
      case StreamKind.Broadcast:
        return this.broadcastMessages$;
      case StreamKind.Ordered:
        return this.orderedMessages$;
      case StreamKind.Schedule:
        return this.scheduleMessages$;
      /* v8 ignore next 5 -- exhaustive switch guard, unreachable */
      default: {
        const _exhaustive: never = kind;

        throw new Error(`Unknown stream kind: ${String(_exhaustive)}`);
      }
    }
  }

  /** Monitor heartbeats and restart the consumer iterator on prolonged silence. */
  private monitorConsumerHealth(messages: ConsumerMessages, name: string): void {
    void (async (): Promise<void> => {
      for await (const status of messages.status()) {
        // Threshold: 2 consecutive missed heartbeats triggers restart.
        // One missed heartbeat can happen during normal GC pauses or brief network blips.
        // A second miss in a row indicates a stale consumer.
        if (status.type === 'heartbeats_missed' && status.count >= 2) {
          this.logger.warn(`Consumer ${name}: ${status.count} heartbeats missed, restarting`);
          messages.stop();
          break;
        }
      }
    })().catch((err: unknown) => {
      // Iterator closed on destroy is expected; log anything else
      /* v8 ignore next 3 -- debug-only observability, no business logic */
      if (err) {
        this.logger.debug(`Consumer ${name} health monitor ended:`, err);
      }
    });
  }

  /** Create a self-healing ordered consumer flow. */
  private createOrderedFlow(
    streamName: string,
    consumerOpts: Partial<OrderedConsumerOptions>,
  ): Observable<void> {
    return this.createSelfHealingFlow(
      (onConnected) => this.consumeOrderedOnce(streamName, consumerOpts, onConnected),
      StreamKind.Ordered,
      this.trackFlow(StreamKind.Ordered, null),
      (err) => {
        // Fail fast on first error so listen() propagates the failure.
        // Subsequent errors (after retry) are handled by the self-healing loop.
        if (this.orderedReadyReject) {
          this.orderedReadyReject(err);
          this.orderedReadyReject = null;
          this.orderedReadyResolve = null;
        }
      },
    );
  }

  /** Register a flow as down until its first consume() succeeds. */
  private trackFlow(kind: StreamKind, consumer: string | null): ConsumerFlowState {
    const state: ConsumerFlowState = {
      kind,
      consumer,
      active: false,
      connectedOnce: false,
      failures: 0,
      downSince: Date.now(),
      lastError: null,
    };

    this.flowStates.set(kind, state);

    return state;
  }

  /** Shared self-healing flow: defer -> retry with exponential backoff on error/completion. */
  private createSelfHealingFlow(
    source: (onConnected: () => void) => Promise<void>,
    label: string,
    state: ConsumerFlowState,
    onFirstError?: (err: unknown) => void,
  ): Observable<void> {
    let consecutiveFailures = 0;
    // Backoff level, kept apart from the failure count: a reconnect resets it.
    let backoffLevel = 0;

    // Called from inside `source()` once the consumer is actually live
    // (right after `consumer.consume()` resolves, before `messages.closed()`).
    // The log + event are skipped on the very first successful start
    // (no preceding failures) to avoid noise.
    const onConnected = (): void => {
      if (consecutiveFailures > 0) {
        const attempts = consecutiveFailures;

        this.logger.log(`Consumer ${label} recovered after ${attempts} failed attempt(s)`);
        this.eventBus.emit(TransportEvent.ConsumerRecovered, label, attempts);
      }

      consecutiveFailures = 0;
      backoffLevel = 0;
      Object.assign(state, {
        active: true,
        connectedOnce: true,
        failures: 0,
        downSince: null,
        lastError: null,
      });
    };

    const markDown = (): void => {
      state.active = false;
      state.downSince ??= Date.now();
    };

    return defer(() => source(onConnected)).pipe(
      catchError((err) => {
        consecutiveFailures++;
        backoffLevel++;
        markDown();
        state.failures = consecutiveFailures;
        state.lastError = errorMessage(err);
        this.logger.error(`Consumer ${label} error, will restart:`, err);
        this.eventBus.emit(TransportEvent.Error, toError(err), 'message-provider');
        onFirstError?.(err);
        onFirstError = undefined;
        return EMPTY;
      }),
      repeat({
        delay: () => {
          markDown();
          const delay = Math.min(100 * Math.pow(2, backoffLevel), 30_000);

          this.logger.warn(`Consumer ${label} stream ended, restarting in ${delay}ms...`);

          // A long outage leaves the backoff at its cap; once NATS is back,
          // retry at once instead of waiting it out.
          return race(
            timer(delay),
            this.connection.reconnects$.pipe(
              take(1),
              tap(() => {
                backoffLevel = 0;
              }),
            ),
          );
        },
      }),
    );
  }

  /** Single iteration: create ordered consumer -> push messages into the subject. */
  private async consumeOrderedOnce(
    streamName: string,
    consumerOpts: Partial<OrderedConsumerOptions>,
    onConnected: () => void,
  ): Promise<void> {
    const js = this.connection.getJetStreamClient();
    const consumer = await js.consumers.get(streamName, consumerOpts);
    const orderedMessages$ = this.orderedMessages$;
    const messages = await consumer.consume({
      callback: (msg: JsMsg): void => {
        orderedMessages$.next(msg);
      },
    } as ConsumeOptions);

    if (this.orderedReadyResolve) {
      this.orderedReadyResolve();
      this.orderedReadyResolve = null;
      this.orderedReadyReject = null;
    }

    this.activeIterators.add(messages);
    // Signal recovery now: consume() succeeded, the consumer is live.
    // See consumeOnce for the same rationale.
    onConnected();

    try {
      await messages.closed();
    } finally {
      this.activeIterators.delete(messages);
    }
  }
}
