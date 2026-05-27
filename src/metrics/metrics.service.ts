import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { ConnectionProvider } from '../connection';
import { EventBus } from '../hooks';
import type {
  DeadLetterInfo,
  HandlerStatus,
  JetstreamModuleOptions,
  MessageKind,
  PublishStatus,
  RpcOutcomeStatus,
} from '../interfaces';
import { StreamKind, TransportEvent } from '../interfaces';
import { JETSTREAM_CONNECTION, JETSTREAM_OPTIONS, streamName } from '../jetstream.constants';
import { PatternRegistry } from '../server/routing/pattern-registry';

import { mapErrorContext } from './error-context-mapper';
import type { MetricsConfig } from './metrics.config';
import {
  DEFAULT_METRICS_PREFIX,
  DEFAULT_POLL_INTERVAL_MS,
  JETSTREAM_METRICS_CONFIG,
  JETSTREAM_METRICS_PROM_CLIENT,
  STREAM_KIND_LABEL,
  UNMATCHED_SUBJECT_LABEL,
} from './metrics.constants';
import { createMetrics, type JetstreamMetrics, type PromClientRuntime } from './metrics.factory';

/** Stream-kind label used by ConsumerRecovered subscribers. */
type RecoveredKindLabel = StreamKind | string;

/**
 * Resolution result for translating a wire NATS subject to declared metric
 * labels. When the {@link PatternRegistry} is not available (publisher-only
 * mode) or the subject is unknown, callers fall back to the wire subject.
 */
interface ResolvedSubjectLabels {
  pattern: string;
  kind: StreamKind;
}

/**
 * Built-in Prometheus metrics service.
 *
 * Activated only when `JetstreamModuleOptions.metrics` is truthy. On
 * `OnApplicationBootstrap` the service instantiates the full metric set on
 * the configured `prom-client` registry, subscribes to relevant
 * {@link TransportEvent}s, and (in a later phase) starts the polling loop
 * for gauges. Critical-path transport code never imports this module —
 * metrics writes happen entirely off the hot path.
 */
@Injectable()
export class JetstreamMetricsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Jetstream:Metrics');

  private metrics: JetstreamMetrics | null = null;
  private readonly activeServers = new Set<string>();

  public constructor(
    private readonly eventBus: EventBus,
    @Inject(JETSTREAM_METRICS_CONFIG) private readonly config: MetricsConfig,
    @Inject(JETSTREAM_METRICS_PROM_CLIENT) private readonly promClient: PromClientRuntime,
    @Inject(JETSTREAM_OPTIONS) private readonly options: JetstreamModuleOptions,
    @Optional() private readonly patternRegistry: PatternRegistry | null,
    @Optional()
    @Inject(JETSTREAM_CONNECTION)
    private readonly connection: ConnectionProvider | null = null,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    if (this.metrics !== null) return;

    if (!this.config.register) {
      throw new Error(
        'JetstreamMetricsService requires a prom-client Registry — none was resolved by JetstreamMetricsModule.',
      );
    }

    this.metrics = createMetrics({
      register: this.config.register,
      promClient: this.promClient,
      prefix: this.config.prefix,
      defaultLabels: this.config.defaultLabels,
      buckets: this.config.buckets,
    });

    this.subscribeToEvents();
    this.syncInitialConnectionState();
    this.logger.log(
      `Metrics enabled (prefix=${this.config.prefix ?? DEFAULT_METRICS_PREFIX}, poll=${this.getEffectivePollInterval()}ms)`,
    );
  }

  public async onModuleDestroy(): Promise<void> {
    // Polling lifecycle wired in Phase E.
  }

  /**
   * Resolved polling interval in milliseconds. `0` means polling is disabled —
   * only event-driven counters/histograms update.
   *
   * @internal Visible for tests.
   */
  public getEffectivePollInterval(): number {
    return this.config.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * NATS connects during early bootstrap (when consumer infrastructure
   * resolves streams), which is before this service subscribes to the
   * EventBus. As a result the initial `Connect` emission misses us. Mirror
   * the current state here so `connection_up` reflects reality the moment
   * metrics come online — subsequent reconnects/disconnects then update it
   * normally via the EventBus subscribers.
   */
  private syncInitialConnectionState(): void {
    const nc = this.connection?.unwrap;

    if (!nc) return;

    const server = nc.getServer();

    this.activeServers.add(server);
    this.metrics?.connectionUp.labels({ server }).set(1);
  }

  private subscribeToEvents(): void {
    this.eventBus.subscribe(TransportEvent.Connect, this.onConnect);
    this.eventBus.subscribe(TransportEvent.Disconnect, this.onDisconnect);
    this.eventBus.subscribe(TransportEvent.Reconnect, this.onReconnect);
    this.eventBus.subscribe(TransportEvent.Error, this.onError);
    this.eventBus.subscribe(TransportEvent.RpcTimeout, this.onRpcTimeout);
    this.eventBus.subscribe(TransportEvent.MessageRouted, this.onMessageRouted);
    this.eventBus.subscribe(TransportEvent.DeadLetter, this.onDeadLetter);
    this.eventBus.subscribe(TransportEvent.ConsumerRecovered, this.onConsumerRecovered);
    this.eventBus.subscribe(TransportEvent.HandlerCompleted, this.onHandlerCompleted);
    this.eventBus.subscribe(TransportEvent.Published, this.onPublished);
    this.eventBus.subscribe(TransportEvent.RpcCompleted, this.onRpcCompleted);
  }

  private readonly onConnect = (server: string): void => {
    this.activeServers.add(server);
    this.metrics?.connectionUp.labels({ server }).set(1);
  };

  private readonly onReconnect = (server: string): void => {
    this.activeServers.add(server);
    this.metrics?.connectionUp.labels({ server }).set(1);
  };

  private readonly onDisconnect = (): void => {
    // We don't know which server dropped — flip every observed server to 0.
    // The next Connect/Reconnect re-flips it back to 1.
    for (const server of this.activeServers) {
      this.metrics?.connectionUp.labels({ server }).set(0);
    }
  };

  private readonly onError = (_err: Error, context?: string): void => {
    this.metrics?.errorsTotal.labels({ context: mapErrorContext(context) }).inc();
  };

  private readonly onRpcTimeout = (subject: string, _correlationId: string): void => {
    const declared = this.resolveDeclared(subject);

    this.metrics?.rpcTimeoutTotal.labels({ subject: declared?.pattern ?? subject }).inc();
  };

  // The `_kind` parameter from MessageRouted collapses broadcast and ordered
  // into MessageKind.Event, so we rely on declared.kind from PatternRegistry
  // for the most specific label.
  private readonly onMessageRouted = (subject: string, _kind: MessageKind): void => {
    if (!this.metrics) return;

    const declared = this.resolveDeclared(subject);

    if (!declared) {
      this.metrics.messagesUnhandledTotal.labels({ subject: UNMATCHED_SUBJECT_LABEL }).inc();
      return;
    }

    this.metrics.messagesReceivedTotal
      .labels({
        stream: streamName(this.options.name, declared.kind),
        subject: declared.pattern,
        kind: STREAM_KIND_LABEL[declared.kind],
      })
      .inc();
  };

  private readonly onDeadLetter = (info: DeadLetterInfo): void => {
    const declared = this.resolveDeclared(info.subject);

    this.metrics?.messagesDeadLetterTotal
      .labels({ stream: info.stream, subject: declared?.pattern ?? info.subject })
      .inc();
  };

  private readonly onConsumerRecovered = (label: RecoveredKindLabel, _attempts: number): void => {
    // `label` is typically a StreamKind value (the self-healing flow tags by
    // stream kind), but the public hook accepts any string for custom flows.
    // Expand known kinds to readable labels; pass through anything else.
    const kindLabel = (STREAM_KIND_LABEL as Record<string, string>)[label] ?? String(label);

    this.metrics?.consumerRecoveredTotal.labels({ kind: kindLabel }).inc();
  };

  private readonly onHandlerCompleted = (
    pattern: string,
    kind: StreamKind,
    durationMs: number,
    status: HandlerStatus,
  ): void => {
    if (!this.metrics) return;

    const stream = streamName(this.options.name, kind);
    const kindLabel = STREAM_KIND_LABEL[kind];
    const labels = { stream, subject: pattern, kind: kindLabel, status };

    this.metrics.messagesProcessedTotal.labels(labels).inc();
    this.metrics.handlerDurationSeconds.labels(labels).observe(durationMs / 1000);
  };

  private readonly onPublished = (
    pattern: string,
    kind: StreamKind,
    durationMs: number,
    status: PublishStatus,
  ): void => {
    if (!this.metrics) return;

    const labels = { subject: pattern, kind: STREAM_KIND_LABEL[kind], status };

    this.metrics.publishTotal.labels(labels).inc();
    this.metrics.publishDurationSeconds.labels(labels).observe(durationMs / 1000);
  };

  private readonly onRpcCompleted = (
    pattern: string,
    durationMs: number,
    status: RpcOutcomeStatus,
  ): void => {
    this.metrics?.rpcDurationSeconds
      .labels({ subject: pattern, status })
      .observe(durationMs / 1000);
  };

  /**
   * Translate a wire NATS subject to {@link ResolvedSubjectLabels}. Returns
   * `null` when no {@link PatternRegistry} entry matches (unknown subject or
   * publisher-only mode).
   */
  private resolveDeclared(subject: string): ResolvedSubjectLabels | null {
    return this.patternRegistry?.resolveDeclared(subject) ?? null;
  }
}
