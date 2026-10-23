import { Logger } from '@nestjs/common';

import type { JetStreamManager, StoredMsg } from '@nats-io/jetstream';
import type { Msg, Subscription } from '@nats-io/transport-node';

import { ConnectionProvider } from '../../connection';
import type { Codec } from '../../interfaces';
import { DeadLetterCapture } from './dead-letter-capture';
import type {
  DeadLetterSource,
  DeadLetterWatchTarget,
  MaxDeliveriesAdvisory,
} from './routing.types';

const MAX_DELIVERIES_ADVISORY = '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES';

const EXHAUSTED_REASON =
  'Delivery attempts ran out without the message being settled: the handler outlived ack_wait, ' +
  'or the process stopped while handling it';

/**
 * Captures messages the server stopped redelivering without the handler ever
 * settling them on the final attempt: a crash, a hung handler, a shutdown.
 *
 * The server reports each one in a `MAX_DELIVERIES` advisory and keeps the
 * message in the stream. Every replica joins one queue group per consumer, so
 * each advisory is handled once. Advisories are core NATS messages: one sent
 * while no replica is running is not seen, and that message stays in the
 * stream.
 */
export class DeadLetterAdvisoryListener {
  private readonly logger = new Logger('Jetstream:DeadLetter');
  private readonly subscriptions: Subscription[] = [];

  public constructor(
    private readonly connection: ConnectionProvider,
    private readonly capture: DeadLetterCapture,
    private readonly codec: Codec,
  ) {}

  /** Start listening for exhausted deliveries on each target consumer. */
  public async watch(targets: readonly DeadLetterWatchTarget[]): Promise<void> {
    const nc = await this.connection.getConnection();

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

            void this.handle(target, msg);
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
        new Error(EXHAUSTED_REASON),
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
        if (!target.removeOnCapture) return;

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
