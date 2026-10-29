import { Logger } from '@nestjs/common';

import { RetentionPolicy } from '@nats-io/jetstream';
import type { JetStreamManager, StoredMsg } from '@nats-io/jetstream';
import type { Msg, Subscription } from '@nats-io/transport-node';

import { ConnectionProvider } from '../../connection';
import { DeliveryErrorReason, JetstreamDeliveryError } from '../../errors';
import type { Codec } from '../../interfaces';
import { DeadLetterCapture } from './dead-letter-capture';
import type {
  DeadLetterSource,
  DeadLetterWatchTarget,
  MaxDeliveriesAdvisory,
} from './routing.types';

const MAX_DELIVERIES_ADVISORY = '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES';

/** Advisories handled at once; a burst after an outage queues behind these. */
const MAX_CONCURRENT_CAPTURES = 8;

const EXHAUSTED_REASON =
  'Delivery attempts ran out without the message being settled: the handler outlived ack_wait, ' +
  'or the process stopped while handling it';

/**
 * Captures messages the server stopped redelivering without the handler ever
 * settling them on the final attempt: a crash, a hung handler, a shutdown.
 *
 * The server reports each one in a `MAX_DELIVERIES` advisory and keeps the
 * message in the stream. Every replica joins one queue group per consumer, so
 * each advisory is handled once. A captured message is deleted only from a
 * work-queue stream; elsewhere other consumers may still need it. Advisories are core NATS messages: one sent
 * while no replica is running is not seen, and that message stays in the
 * stream.
 */
export class DeadLetterAdvisoryListener {
  private readonly logger = new Logger('Jetstream:DeadLetter');
  private readonly subscriptions: Subscription[] = [];
  /** Streams whose captured messages are deleted. */
  private readonly workQueues = new Set<string>();
  private readonly backlog: (() => Promise<void>)[] = [];
  private active = 0;

  public constructor(
    private readonly connection: ConnectionProvider,
    private readonly capture: DeadLetterCapture,
    private readonly codec: Codec,
  ) {}

  /** Start listening for exhausted deliveries on each target consumer. */
  public async watch(targets: readonly DeadLetterWatchTarget[]): Promise<void> {
    const nc = await this.connection.getConnection();

    await this.readRetention(targets);

    for (const target of targets) {
      const subscription = nc.subscribe(
        `${MAX_DELIVERIES_ADVISORY}.${target.stream}.${target.consumer}`,
        {
          queue: target.consumer,
          callback: (err, msg) => {
            if (err) {
              this.logger.error(
                `Dead-letter advisory subscription for ${target.consumer} failed:`,
                err,
              );

              return;
            }

            this.enqueue(() => this.handle(target, msg));
          },
        },
      );

      this.subscriptions.push(subscription);
    }
  }

  public stop(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }

    this.subscriptions.length = 0;
  }

  private async readRetention(targets: readonly DeadLetterWatchTarget[]): Promise<void> {
    const jsm = await this.connection.getJetStreamManager();

    for (const stream of new Set(targets.map((target) => target.stream))) {
      try {
        const info = await jsm.streams.info(stream);

        if (info.config.retention === RetentionPolicy.Workqueue) this.workQueues.add(stream);
      } catch (err) {
        // Without the retention known, keeping a captured message is the safe side.
        this.logger.warn(
          `Could not read the retention of ${stream}; dead letters stay in it:`,
          err,
        );
      }
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.backlog.push(task);
    this.drain();
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENT_CAPTURES) {
      const task = this.backlog.shift();

      if (task === undefined) return;

      this.active += 1;
      void task().finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }

  private async handle(target: DeadLetterWatchTarget, msg: Msg): Promise<void> {
    const advisory = this.parse(msg);

    if (advisory?.stream_seq === undefined) {
      this.logger.warn(`Ignoring a malformed MAX_DELIVERIES advisory for ${target.consumer}`);

      return;
    }

    const seq = advisory.stream_seq;

    try {
      const jsm = await this.connection.getJetStreamManager();
      const stored = await jsm.streams.getMessage(target.stream, { seq });

      // Already gone: settled or removed between the advisory and now.
      if (!stored) return;

      await this.capture.captureSource(
        this.source(jsm, target, stored, advisory.deliveries ?? 0),
        this.decode(stored.data),
        new JetstreamDeliveryError(DeliveryErrorReason.DeliveriesExhausted, EXHAUSTED_REASON),
      );
    } catch (err) {
      this.logger.error(
        `Could not capture message ${seq} from ${target.stream} after its deliveries ran out; ` +
          'it stays in the stream:',
        err,
      );
    }
  }

  private source(
    jsm: JetStreamManager,
    target: DeadLetterWatchTarget,
    stored: StoredMsg,
    deliveryCount: number,
  ): DeadLetterSource {
    return {
      subject: stored.subject,
      data: stored.data,
      headers: stored.header,
      stream: target.stream,
      streamSequence: stored.seq,
      deliveryCount,
      timestamp: stored.time,
      release: async () => {
        if (!this.workQueues.has(target.stream)) return;

        try {
          await jsm.streams.deleteMessage(target.stream, stored.seq, false);
        } catch (err) {
          this.logger.error(
            `Dead letter ${stored.seq} was captured but could not be deleted from ${target.stream}:`,
            err,
          );
        }
      },
      // Nothing to undo: the message never left the stream.
      retain: () => undefined,
    };
  }

  private parse(msg: Msg): MaxDeliveriesAdvisory | null {
    try {
      const advisory = msg.json<MaxDeliveriesAdvisory>();

      return typeof advisory.stream_seq === 'number' ? advisory : null;
    } catch {
      return null;
    }
  }

  /** The decoded payload, or the raw bytes when the codec cannot read them. */
  private decode(data: Uint8Array): unknown {
    try {
      return this.codec.decode(data);
    } catch {
      return data;
    }
  }
}
