import { Logger } from '@nestjs/common';
import { Consumer, ConsumerInfo, ConsumerMessages, JsMsg } from 'nats';
import {
  catchError,
  defer,
  EMPTY,
  merge,
  Observable,
  repeat,
  Subject,
  takeUntil,
  timer,
} from 'rxjs';

import { ConnectionProvider } from '../../connection';
import { EventBus } from '../../hooks';
import type { StreamKind } from '../../interfaces';
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
  private readonly destroy$ = new Subject<void>();
  private readonly activeIterators = new Set<ConsumerMessages>();

  private readonly eventMessages$ = new Subject<JsMsg>();
  private readonly commandMessages$ = new Subject<JsMsg>();
  private readonly broadcastMessages$ = new Subject<JsMsg>();

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

  /** Stop all consumer flows and complete all subjects. */
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
  }

  /** Create a self-healing consumer flow for a specific kind. */
  private createFlow(kind: StreamKind, info: ConsumerInfo): Observable<void> {
    const target$ = this.getTargetSubject(kind);

    return defer(() => this.consumeOnce(info, target$)).pipe(
      catchError((err) => {
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
          this.logger.warn(`Consumer ${info.name} stream ended, restarting...`);
          this.eventBus.emit(
            TransportEvent.Error,
            new Error(`Consumer ${info.name} stream ended`),
            'message-provider',
          );
          return timer(100);
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
    }
  }
}
