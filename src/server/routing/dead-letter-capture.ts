import { Logger } from '@nestjs/common';
import type { JsMsg } from '@nats-io/jetstream';
import { headers as natsHeaders, type MsgHdrs } from '@nats-io/transport-node';

import { ConnectionProvider } from '../../connection';
import { EventBus } from '../../hooks';
import { TransportEvent } from '../../interfaces';
import type { DeadLetterConfig, DeadLetterInfo, JetstreamModuleOptions } from '../../interfaces';
import {
  dlqStreamName,
  JetstreamDlqHeader,
  NATS_CONTROL_HEADER_PREFIX,
} from '../../jetstream.constants';
import { settleQuietly } from '../../utils';
import { withDeadLetterSpan, type ResolvedOtelOptions, type ServerEndpoint } from '../../otel';

import { NameResolver } from '../infrastructure/name-resolver';
import { PatternRegistry } from './pattern-registry';

/** How many times a dead letter is published to the DLQ stream before falling back. */
const DLQ_PUBLISH_ATTEMPTS = 3;

/**
 * Captures messages that exhausted their delivery limits: publishes them to
 * the DLQ stream (when configured) or hands them to the `onDeadLetter`
 * callback, then settles the original message.
 */
export class DeadLetterCapture {
  private readonly logger = new Logger('Jetstream:DeadLetter');

  public constructor(
    private readonly patternRegistry: PatternRegistry,
    private readonly eventBus: EventBus,
    private readonly deadLetterConfig: DeadLetterConfig,
    private readonly otel: ResolvedOtelOptions,
    private readonly serviceName: string,
    private readonly serverEndpoint: ServerEndpoint | null,
    private readonly connection?: ConnectionProvider,
    private readonly options?: JetstreamModuleOptions,
    private readonly names?: NameResolver,
  ) {}

  /** True when this delivery is the consumer's last attempt for the message. */
  public isFinalDelivery(msg: JsMsg): boolean {
    // updateMaxDeliverMap() populates maxDeliverByStream after consumers are
    // ensured; optional chaining guards the brief startup window before then.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime lifecycle guard
    const maxDeliver = this.deadLetterConfig.maxDeliverByStream?.get(msg.info.stream);

    if (maxDeliver === undefined || maxDeliver <= 0) return false;

    return msg.info.deliveryCount >= maxDeliver;
  }

  /** Emit the dead-letter event and route the message to the DLQ or the fallback callback. */
  public async capture(msg: JsMsg, data: unknown, error: unknown): Promise<void> {
    const info: DeadLetterInfo = {
      subject: msg.subject,
      data,
      headers: msg.headers,
      error,
      deliveryCount: msg.info.deliveryCount,
      stream: msg.info.stream,
      streamSequence: msg.info.streamSequence,
      timestamp: new Date(msg.info.timestampNanos / 1_000_000).toISOString(),
    };

    await withDeadLetterSpan(
      {
        msg,
        // Surface the registered pattern so APM can filter dead letters by
        // handler; falls back to the raw subject when no handler matches.
        pattern: this.patternRegistry.getHandler(msg.subject) ? msg.subject : undefined,
        finalDeliveryCount: msg.info.deliveryCount,
        reason: error instanceof Error ? error.message : String(error),
        serviceName: this.serviceName,
        endpoint: this.serverEndpoint,
      },
      this.otel,
      async () => {
        this.eventBus.emit(TransportEvent.DeadLetter, info);

        if (!this.options?.dlq) {
          await this.fallbackToOnDeadLetterCallback(info, msg);
        } else {
          await this.publishToDlq(msg, info, error);
        }
      },
    );
  }

  /**
   * Publish the dead letter to the DLQ stream with diagnostic headers. On
   * success the `onDeadLetter` callback is notified and the message termed;
   * on failure everything falls back to the callback to avoid silent loss.
   */
  private async publishToDlq(msg: JsMsg, info: DeadLetterInfo, error: unknown): Promise<void> {
    const serviceName = this.options?.name;

    if (!this.connection || !serviceName) {
      this.logger.error(
        `Cannot publish to DLQ for ${msg.subject}: Connection or Module Options unavailable`,
      );
      await this.fallbackToOnDeadLetterCallback(info, msg);

      return;
    }

    const dlqStreamOverride = this.options.dlq?.stream?.name;
    const destinationSubject = this.names
      ? this.names.dlqStreamName()
      : (dlqStreamOverride ?? dlqStreamName(serviceName));
    const hdrs = this.buildDlqHeaders(msg);

    hdrs.set(JetstreamDlqHeader.DeadLetterReason, this.extractErrorReason(error));
    hdrs.set(JetstreamDlqHeader.OriginalSubject, msg.subject);
    hdrs.set(JetstreamDlqHeader.OriginalStream, msg.info.stream);
    hdrs.set(JetstreamDlqHeader.FailedAt, new Date().toISOString());
    hdrs.set(JetstreamDlqHeader.DeliveryCount, msg.info.deliveryCount.toString());

    try {
      await this.publishWithRetry(this.connection, destinationSubject, msg.data, hdrs);
      this.logger.log(`Message sent to DLQ: ${msg.subject}`);
      await this.notifyDeadLetterCallback(info, msg);
    } catch (publishErr) {
      this.logger.error(`Failed to publish to DLQ for ${msg.subject}:`, publishErr);
      await this.fallbackToOnDeadLetterCallback(info, msg);
    }
  }

  /**
   * Past max_deliver the server never redelivers, so these in-process attempts
   * are the only second chance a dead letter gets. No artificial delay: an
   * unreachable broker already spaces attempts via its own request timeout.
   */
  private async publishWithRetry(
    connection: ConnectionProvider,
    subject: string,
    data: Uint8Array,
    headers: MsgHdrs,
  ): Promise<void> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= DLQ_PUBLISH_ATTEMPTS; attempt += 1) {
      try {
        await connection.getJetStreamClient().publish(subject, data, { headers });

        return;
      } catch (err) {
        lastErr = err;

        if (attempt < DLQ_PUBLISH_ATTEMPTS) {
          this.logger.warn(
            `DLQ publish attempt ${attempt}/${DLQ_PUBLISH_ATTEMPTS} failed for ${subject}, retrying`,
          );
        }
      }
    }

    throw lastErr;
  }

  /**
   * Copy headers for the DLQ republish, dropping NATS control headers: a
   * copied Nats-TTL would expire the DLQ entry, Nats-Msg-Id trips dedup.
   */
  private buildDlqHeaders(msg: JsMsg): MsgHdrs {
    const hdrs = natsHeaders();

    if (!msg.headers) return hdrs;

    for (const [k, v] of msg.headers) {
      if (k.toLowerCase().startsWith(NATS_CONTROL_HEADER_PREFIX)) continue;

      for (const val of v) {
        hdrs.append(k, val);
      }
    }

    return hdrs;
  }

  private async notifyDeadLetterCallback(info: DeadLetterInfo, msg: JsMsg): Promise<void> {
    if (this.deadLetterConfig.onDeadLetter) {
      try {
        await this.deadLetterConfig.onDeadLetter(info);
      } catch (hookErr) {
        this.logger.warn(
          `onDeadLetter callback failed after successful DLQ publish for ${msg.subject}`,
          hookErr,
        );
      }
    }

    settleQuietly(this.logger, `Failed to term ${msg.subject}:`, () => {
      msg.term('Moved to DLQ stream');
    });
  }

  /**
   * Last resort: invoke onDeadLetter, then term on success. On failure the
   * message is nak'd: never redelivered past max_deliver, but preserved.
   */
  private async fallbackToOnDeadLetterCallback(info: DeadLetterInfo, msg: JsMsg): Promise<void> {
    const onDeadLetter = this.deadLetterConfig.onDeadLetter;

    if (!onDeadLetter) {
      // dlq-only mode with a failed DLQ publish; keep the message in the stream.
      this.logger.error(
        `Dead letter for ${msg.subject} could not be captured (DLQ publish failed, no onDeadLetter callback); leaving the message in the stream`,
      );
      settleQuietly(this.logger, `Failed to nak ${msg.subject}:`, () => {
        msg.nak();
      });

      return;
    }

    try {
      await onDeadLetter(info);
      settleQuietly(this.logger, `Failed to term ${msg.subject}:`, () => {
        msg.term('Dead letter processed via fallback callback');
      });
    } catch (hookErr) {
      this.logger.error(
        `Fallback onDeadLetter callback failed for ${msg.subject}; the message stays in the stream and will not be redelivered (max_deliver exhausted); recover it manually:`,
        hookErr,
      );
      settleQuietly(this.logger, `Failed to nak ${msg.subject}:`, () => {
        msg.nak();
      });
    }
  }

  private extractErrorReason(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'object' && error !== null && 'message' in error) {
      return String((error as Record<string, unknown>).message);
    }

    return String(error);
  }
}
