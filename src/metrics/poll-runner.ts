import { Logger } from '@nestjs/common';
import type { JetStreamManager } from '@nats-io/jetstream';

import type { StreamKind } from '../interfaces';

import type { JetstreamMetrics } from './metrics.factory';
import { STREAM_KIND_LABEL } from './metrics.constants';

/** A consumer this service owns: stream + durable + StreamKind for labelling. */
export interface ConsumerPollTarget {
  kind: StreamKind;
  stream: string;
  consumer: string;
}

/**
 * Resolved inputs for {@link PollRunner}. `targets` lists every consumer this
 * service owns (one per active StreamKind). Stream gauges are derived from
 * `targets[].stream`, deduplicated internally.
 */
export interface PollRunnerOptions {
  intervalMs: number;
  jsmFactory(): Promise<JetStreamManager>;
  metrics: JetstreamMetrics;
  targets: ConsumerPollTarget[];
}

/** Bounded label values for `metrics_poll_errors_total{target}`. */
type PollErrorTarget = 'consumer.info' | 'stream.info' | 'jsm.connect';

/**
 * Periodically pulls consumer + stream info from `JetStreamManager` and writes
 * the latest values to the gauge metrics. Each tick is guarded so:
 *
 *  - Overlapping ticks are skipped (no queueing) when a previous cycle has not
 *    completed within the interval.
 *  - Per-target failures are isolated — a single broken consumer cannot stop
 *    the cycle, and the failure surfaces via `metrics_poll_errors_total`.
 *
 * Stops cleanly via {@link stop}: clears the timer and awaits the in-flight
 * tick so unit/integration tests are not left with detached promises.
 */
export class PollRunner {
  private readonly logger = new Logger('Jetstream:Metrics:Poll');
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  public constructor(private readonly opts: PollRunnerOptions) {}

  public start(): void {
    if (this.timer !== null) return;
    if (this.opts.intervalMs <= 0) return;
    if (this.opts.targets.length === 0) return;

    this.timer = setInterval(() => {
      if (this.inFlight !== null) {
        this.logger.warn('Skipping poll tick — previous cycle still in flight');
        return;
      }

      this.inFlight = this.tick().finally(() => {
        this.inFlight = null;
      });
    }, this.opts.intervalMs);
  }

  public async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.inFlight !== null) await this.inFlight;
  }

  /**
   * @internal Visible for tests. Runs one poll cycle synchronously.
   */
  public async tick(): Promise<void> {
    let jsm: JetStreamManager;

    try {
      jsm = await this.opts.jsmFactory();
    } catch {
      this.recordPollError('jsm.connect');
      return;
    }

    await Promise.all([this.pollConsumers(jsm), this.pollStreams(jsm)]);
  }

  private async pollConsumers(jsm: JetStreamManager): Promise<void> {
    for (const target of this.opts.targets) {
      try {
        const info = await jsm.consumers.info(target.stream, target.consumer);
        const labels = {
          stream: target.stream,
          consumer: target.consumer,
          kind: STREAM_KIND_LABEL[target.kind],
        };

        this.opts.metrics.consumerNumPending.labels(labels).set(info.num_pending);
        this.opts.metrics.consumerNumAckPending.labels(labels).set(info.num_ack_pending);
        this.opts.metrics.consumerNumRedelivered.labels(labels).set(info.num_redelivered);
        this.opts.metrics.consumerNumWaiting.labels(labels).set(info.num_waiting);
      } catch {
        // Single-consumer failures stay isolated: a missing/recreating consumer
        // shouldn't prevent the rest of the cycle from collecting data.
        this.recordPollError('consumer.info');
      }
    }
  }

  private async pollStreams(jsm: JetStreamManager): Promise<void> {
    const uniqueStreams = new Set(this.opts.targets.map((t) => t.stream));

    for (const stream of uniqueStreams) {
      try {
        const info = await jsm.streams.info(stream);

        this.opts.metrics.streamMessages.labels({ stream }).set(info.state.messages);
        this.opts.metrics.streamBytes.labels({ stream }).set(info.state.bytes);
      } catch {
        this.recordPollError('stream.info');
      }
    }
  }

  private recordPollError(target: PollErrorTarget): void {
    this.opts.metrics.metricsPollErrorsTotal.labels({ target }).inc();
  }
}
