import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Consumer, ConsumerInfo, JsMsg } from 'nats';
import {
  catchError,
  defer,
  EMPTY,
  from,
  merge,
  Observable,
  of,
  repeat,
  Subject,
  Subscription,
  switchMap,
  take,
  takeUntil,
  timer,
} from 'rxjs';

import { ConnectionProvider } from '../../common/connection.provider';
import { JetStreamKind } from '../../enum';

import { ConsumerProvider } from './consumer.provider';

/**
 * Manages NATS JetStream pull-based message consumption with automatic reconnection.
 *
 * This provider orchestrates the lifecycle of JetStream consumers, handling:
 * - Initial consumer setup and subscription
 * - Automatic recovery from NATS restarts or connection failures
 * - Separate handling for Event and Command (RPC) messages
 * - Graceful shutdown and resource cleanup.
 *
 * The implementation uses RxJS `defer()` + `repeat()` pattern to ensure consumers
 * automatically restart after the async iterator completes (e.g., during NATS restart),
 * preventing message loss during reconnection windows.
 *
 * Message flow:
 * - Event messages → eventMessages$ subject (ack immediately)
 * - Command messages → commandMessages$ subject (ack after handler success).
 */
@Injectable()
export class MessageProvider implements OnModuleDestroy {
  private readonly logger = new Logger(MessageProvider.name);

  private readonly destroy$ = new Subject<void>();
  private readonly subscription?: Subscription;

  /**
   * Subject for Event pattern messages.
   * Events are acknowledged immediately upon receipt, regardless of handler outcome.
   */
  private readonly eventMessages$ = new Subject<JsMsg>();

  /**
   * Subject for Command (RPC) pattern messages.
   * Commands are acknowledged only after successful handler execution.
   */
  private readonly commandMessages$ = new Subject<JsMsg>();

  /**
   * Initializes pull consumers for both Event and Command streams.
   *
   * Uses `take(1)` on a consumer map to prevent recreating observables on every
   * reconnection event. Each consumer observable handles its own reconnection logic
   * through the `repeat()` operator, ensuring continuous message delivery even
   * when NATS restarts.
   *
   * @param connectionProvider Connection provider.
   * @param consumerProvider Consumer provider.
   */
  public constructor(
    private readonly connectionProvider: ConnectionProvider,
    private readonly consumerProvider: ConsumerProvider,
  ) {
    this.subscription = this.consumerProvider.consumerMap$
      .pipe(
        take(1), // Only subscribe once to prevent observer recreation on reconnects
        switchMap((consumerMap) => this.initializeConsumers(consumerMap)),
        takeUntil(this.destroy$),
      )
      .subscribe();
  }

  /**
   * Observable stream of Event messages for handler processing.
   * Events should be acknowledged immediately after emission.
   *
   * @returns Observable<JsMsg> of Event messages.
   */
  public get events$(): Observable<JsMsg> {
    return this.eventMessages$.asObservable();
  }

  /**
   * Observable stream of Command (RPC) messages for handler processing.
   * Commands should be acknowledged after successful handler execution.
   *
   * @returns Observable<JsMsg> of Command messages.
   */
  public get commands$(): Observable<JsMsg> {
    return this.commandMessages$.asObservable();
  }

  /**
   * Cleans up resources on module destruction.
   *
   * Completes all subjects and the destroy$ subject to stop all active subscriptions
   * and explicitly unsubscribes from the main subscription.
   */
  public onModuleDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.eventMessages$.complete();
    this.commandMessages$.complete();
    this.subscription?.unsubscribe();
  }

  /**
   * Initializes and starts consumer flows for available stream types.
   *
   * Creates separate observable flows for Event and Command consumers,
   * each pushing messages to their respective subjects. Returns a merged
   * observable that completes only when all consumers are done.
   *
   * @param consumerMap Map of consumer info by stream kind.
   * @returns Observable that completes when all consumers are initialized.
   */
  private initializeConsumers(consumerMap: Map<JetStreamKind, ConsumerInfo>): Observable<void> {
    const flows: Observable<void>[] = [];

    const evConsumer = consumerMap.get(JetStreamKind.Event);
    const cmdConsumer = consumerMap.get(JetStreamKind.Command);

    if (evConsumer) flows.push(this.createConsumerFlow(evConsumer, JetStreamKind.Event));
    if (cmdConsumer) flows.push(this.createConsumerFlow(cmdConsumer, JetStreamKind.Command));

    return merge(...flows).pipe(takeUntil(this.destroy$));
  }

  /**
   * Creates a self-healing consumer flow with automatic restart capability.
   *
   * Uses `defer()` to create a fresh observable on each subscription attempt,
   * and `repeat()` to automatically restart when the async iterator completes
   * (e.g., after NATS restart). This pattern ensures no messages are lost
   * during reconnection periods.
   *
   * Messages are routed to the appropriate subject based on the stream kind:
   * - Event messages → eventMessages$
   * - Command messages → commandMessages$.
   *
   * The flow:
   * 1. Fetches the JetStream consumer instance
   * 2. Calls consume() to get an async iterator
   * 3. Converts iterator to observable and emits messages to the appropriate subject
   * 4. On completion, waits 100ms and restarts (via repeat)
   * 5. On fatal error, logs and stops the flow.
   *
   * @param consumerInfo Consumer metadata from NATS.
   * @param kind Stream kind (Event or Command).
   * @returns Observable that manages the consumer lifecycle.
   */
  private createConsumerFlow(consumerInfo: ConsumerInfo, kind: JetStreamKind): Observable<void> {
    const targetSubject$ =
      kind === JetStreamKind.Event ? this.eventMessages$ : this.commandMessages$;

    return defer(() => this.startConsumerIteration(consumerInfo, targetSubject$)).pipe(
      repeat({
        delay: () => {
          this.logger.warn(`Consumer ${consumerInfo.name} stream completed. Restarting...`);
          return timer(100);
        },
      }),

      catchError((err) => {
        this.logger.error(`Fatal error in consumer ${consumerInfo.name}:`, err);
        return EMPTY;
      }),

      takeUntil(this.destroy$),
    );
  }

  /**
   * Executes a single iteration of consumer message processing.
   *
   * This method represents one complete lifecycle of the consumer:
   * - Retrieves the consumer from JetStream
   * - Starts the consume() async iterator
   * - Emits messages to the target subject.
   *
   * When the async iterator completes (e.g., connection lost), this observable
   * completes, triggering the `repeat()` operator to restart the flow.
   *
   * @param consumerInfo Consumer metadata.
   * @param targetSubject$ Subject to emit messages to (events$ or commands$).
   * @returns Observable that completes when the iteration ends.
   */
  private startConsumerIteration(
    consumerInfo: ConsumerInfo,
    targetSubject$: Subject<JsMsg>,
  ): Observable<void> {
    return of(consumerInfo).pipe(
      switchMap((info) => this.getConsumer(info)),
      switchMap((consumer) => this.consumeMessages(consumer, targetSubject$)),
    );
  }

  /**
   * Converts the consumer's async iterator into an RxJS observable stream.
   *
   * Calls consumer.consume() to get the async message iterator, converts it
   * to an observable, and emits each message to the target subject.
   *
   * @param consumer JetStream consumer instance.
   * @param targetSubject$ Subject to emit messages to.
   * @returns Observable that emits void and completes when iterator ends.
   */
  private consumeMessages(consumer: Consumer, targetSubject$: Subject<JsMsg>): Observable<void> {
    return from(consumer.consume()).pipe(
      switchMap((messages) => from(messages as AsyncIterable<JsMsg>)),
      switchMap((msg) => {
        targetSubject$.next(msg);
        return of(void 0);
      }),
    );
  }

  /**
   * Retrieves a JetStream consumer instance by stream and consumer name.
   *
   * @param consumerInfo Consumer metadata containing stream and consumer names.
   * @returns Observable of the consumer instance.
   */
  private getConsumer(consumerInfo: ConsumerInfo): Observable<Consumer> {
    return this.connectionProvider.jsm.pipe(
      switchMap((jsm) => {
        const consumerPromise = jsm
          .jetstream()
          .consumers.get(consumerInfo.stream_name, consumerInfo.name);

        return from(consumerPromise);
      }),
    );
  }
}
