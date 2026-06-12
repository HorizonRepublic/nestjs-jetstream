import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import type { JetStreamManager } from '@nats-io/jetstream';

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
import {
  consumerName,
  isJetStreamRpcMode,
  JETSTREAM_CONNECTION,
  JETSTREAM_OPTIONS,
  streamName,
} from '../jetstream.constants';
import { NameResolver } from '../server/infrastructure/name-resolver';
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
import { createMetrics } from './metrics.factory';
import { PollRunner } from './poll-runner';
import type {
  ConsumerPollTarget,
  JetstreamMetrics,
  PromClientRuntime,
  RecoveredKindLabel,
  ResolvedSubjectLabels,
} from './metrics.types';

/**
 * Built-in Prometheus metrics service. On bootstrap, instantiates the metric
 * set, subscribes to the EventBus, and starts the gauge polling loop.
 * Critical-path transport code never imports this module; metrics writes
 * happen entirely off the hot path.
 */
@Injectable()
export class JetstreamMetricsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Jetstream:Metrics');

  private metrics: JetstreamMetrics | null = null;
  private pollRunner: PollRunner | null = null;
  private readonly activeServers = new Set<string>();

  public constructor(
    private readonly eventBus: EventBus,
    @Inject(JETSTREAM_METRICS_CONFIG) private readonly config: MetricsConfig | null,
    @Inject(JETSTREAM_METRICS_PROM_CLIENT) private readonly promClient: PromClientRuntime | null,
    @Inject(JETSTREAM_OPTIONS) private readonly options: JetstreamModuleOptions,
    @Optional() private readonly patternRegistry: PatternRegistry | null,
    @Optional()
    @Inject(JETSTREAM_CONNECTION)
    private readonly connection: ConnectionProvider | null = null,
    @Optional() private readonly names: NameResolver | null = null,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    if (this.metrics !== null) return;

    // Disabled: `metrics` was omitted/false. prom-client is never resolved
    // in this branch, so the service is a no-op for publisher-only or
    // metrics-off deployments.
    if (!this.options.metrics || !this.config || !this.promClient) return;

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
    this.startPolling();
    this.logger.log(
      `Metrics enabled (prefix=${this.config.prefix ?? DEFAULT_METRICS_PREFIX}, poll=${this.getEffectivePollInterval()}ms)`,
    );
  }

  public async onModuleDestroy(): Promise<void> {
    await this.pollRunner?.stop();
    this.pollRunner = null;
  }

  /** @internal Visible for tests. `0` disables polling. */
  public getEffectivePollInterval(): number {
    return this.config?.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * NATS connects during early bootstrap, before this service subscribes to
   * the EventBus, so the initial `Connect` emission misses us. Mirror the
   * current state here so `connection_up` reflects reality the moment metrics
   * come online; later disconnects/reconnects update it normally.
   */
  private syncInitialConnectionState(): void {
    const nc = this.connection?.unwrap;

    if (!nc) return;

    const server = nc.getServer();

    this.activeServers.add(server);
    this.metrics?.connectionUp.labels({ server }).set(1);
  }

  /** Skips polling for publisher-only deployments and when no kinds are active. */
  private startPolling(): void {
    const interval = this.getEffectivePollInterval();
    const connection = this.connection;

    if (interval <= 0 || !this.patternRegistry || !connection || !this.metrics) return;

    const targets = this.buildPollTargets();

    if (targets.length === 0) return;

    this.pollRunner = new PollRunner({
      intervalMs: interval,
      jsmFactory: async (): Promise<JetStreamManager> => connection.getJetStreamManager(),
      metrics: this.metrics,
      targets,
    });
    this.pollRunner.start();
  }

  private buildPollTargets(): ConsumerPollTarget[] {
    const registry = this.patternRegistry;

    if (!registry) return [];

    const targets: ConsumerPollTarget[] = [];

    if (registry.hasEventHandlers()) {
      targets.push({
        kind: StreamKind.Event,
        stream: this.resolveStreamName(StreamKind.Event),
        consumer: this.resolveConsumerName(StreamKind.Event),
      });
    }

    // Core RPC mode owns no JetStream stream; only JetStream RPC mode does.
    if (registry.hasRpcHandlers() && isJetStreamRpcMode(this.options.rpc)) {
      targets.push({
        kind: StreamKind.Command,
        stream: this.resolveStreamName(StreamKind.Command),
        consumer: this.resolveConsumerName(StreamKind.Command),
      });
    }

    if (registry.hasBroadcastHandlers()) {
      targets.push({
        kind: StreamKind.Broadcast,
        stream: this.resolveStreamName(StreamKind.Broadcast),
        consumer: this.resolveConsumerName(StreamKind.Broadcast),
      });
    }

    // Ordered consumers are ephemeral; no stable durable name to poll.

    return targets;
  }

  private resolveStreamName(kind: StreamKind): string {
    return this.names ? this.names.streamName(kind) : streamName(this.options.name, kind);
  }

  private resolveConsumerName(kind: StreamKind): string {
    return this.names ? this.names.consumerName(kind) : consumerName(this.options.name, kind);
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
    // Disconnect carries no server name: flip every observed server to 0;
    // the next Connect/Reconnect re-flips the live one back to 1.
    for (const server of this.activeServers) {
      this.metrics?.connectionUp.labels({ server }).set(0);
    }
  };

  private readonly onError = (_err: Error, context?: string): void => {
    this.metrics?.errorsTotal.labels({ context: mapErrorContext(context) }).inc();
  };

  private readonly onRpcTimeout = (subject: string, _correlationId: string): void => {
    const declared = this.resolveDeclared(subject);
    const subjectLabel = declared?.pattern ?? UNMATCHED_SUBJECT_LABEL;

    this.metrics?.rpcTimeoutTotal.labels({ subject: subjectLabel }).inc();
  };

  // `_kind` collapses broadcast/ordered into MessageKind.Event; we use
  // declared.kind from PatternRegistry for the precise label instead.
  private readonly onMessageRouted = (subject: string, _kind: MessageKind): void => {
    if (!this.metrics) return;

    const declared = this.resolveDeclared(subject);

    if (!declared) {
      this.metrics.messagesUnhandledTotal.labels({ subject: UNMATCHED_SUBJECT_LABEL }).inc();
      return;
    }

    this.metrics.messagesReceivedTotal
      .labels({
        stream: this.resolveStreamName(declared.kind),
        subject: declared.pattern,
        kind: STREAM_KIND_LABEL[declared.kind],
      })
      .inc();
  };

  private readonly onDeadLetter = (info: DeadLetterInfo): void => {
    const declared = this.resolveDeclared(info.subject);
    const subjectLabel = declared?.pattern ?? UNMATCHED_SUBJECT_LABEL;

    this.metrics?.messagesDeadLetterTotal
      .labels({ stream: info.stream, subject: subjectLabel })
      .inc();
  };

  private readonly onConsumerRecovered = (label: RecoveredKindLabel, _attempts: number): void => {
    // Self-healing usually tags by StreamKind, but the hook accepts any string.
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

    const stream = this.resolveStreamName(kind);
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

  private resolveDeclared(subject: string): ResolvedSubjectLabels | null {
    return this.patternRegistry?.resolveDeclared(subject) ?? null;
  }
}
