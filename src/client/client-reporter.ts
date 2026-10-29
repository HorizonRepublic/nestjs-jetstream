import type { EventBus } from '../hooks';
import { TransportEvent } from '../interfaces';
import type { PublishStatus, RpcOutcomeStatus, StreamKind } from '../interfaces';

/**
 * Reports client-side publishes and RPC round-trips to the event bus. hasHook
 * is per-emit so late subscribers (JetstreamMetricsService during
 * OnApplicationBootstrap) still receive events.
 */
export class ClientReporter {
  public constructor(private readonly eventBus: EventBus) {}

  public published(
    declaredPattern: string,
    kind: StreamKind,
    startedAt: number,
    status: PublishStatus,
  ): void {
    if (!this.eventBus.hasHook(TransportEvent.Published)) return;
    this.eventBus.emit(
      TransportEvent.Published,
      declaredPattern,
      kind,
      performance.now() - startedAt,
      status,
    );
  }

  public rpcCompleted(declaredPattern: string, startedAt: number, status: RpcOutcomeStatus): void {
    if (!this.eventBus.hasHook(TransportEvent.RpcCompleted)) return;
    this.eventBus.emit(
      TransportEvent.RpcCompleted,
      declaredPattern,
      performance.now() - startedAt,
      status,
    );
  }
}
