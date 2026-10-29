import { Logger } from '@nestjs/common';

import type { JsMsg } from '@nats-io/jetstream';
import { headers as natsHeaders, type MsgHdrs } from '@nats-io/transport-node';

import { ConnectionProvider } from '../../connection';
import { JetstreamPublishError, toPublishError } from '../../errors';
import { EventBus } from '../../hooks';
import { TransportEvent } from '../../interfaces';
import type { DeadLetterConfig, DeadLetterInfo, JetstreamModuleOptions } from '../../interfaces';
import {
  dlqStreamName,
  JetstreamDlqHeader,
  NATS_CONTROL_HEADER_PREFIX,
} from '../../jetstream.constants';
import { withDeadLetterSpan, type ResolvedOtelOptions, type ServerEndpoint } from '../../otel';
import { errorMessage, settleQuietly } from '../../utils';
import { dlqStreamOverrides, isDlqEnabled } from '../infrastructure/dlq-options';
import { NameResolver } from '../infrastructure/name-resolver';
import { PatternRegistry } from './pattern-registry';
import type { DeadLetterSource } from './routing.types';

/** How many times a dead letter is published to the DLQ stream before falling back. */
const DLQ_PUBLISH_ATTEMPTS = 3;

/** A full DLQ stream rejects every attempt the same way, so retrying it only delays the fallback. */
const isStreamFull = (err: unknown): boolean =>
  toPublishError(err) instanceof JetstreamPublishError;

/** How long a captured message is remembered, so a second report of it is dropped. */
const CAPTURED_MEMORY_MS = 10 * 60_000;

/** Upper bound on remembered captures; the oldest are forgotten first. */
const CAPTURED_MEMORY_LIMIT = 10_000;

/*
 * Identifies one stream message across both capture paths. The sequence alone
 * repeats once a stream is recreated, so the stored time goes with it.
 */
const captureKey = (msg: DeadLetterSource): string =>
  `${msg.stream}:${msg.streamSequence}:${msg.timestamp.getTime()}`;

/** The live delivery a handler just failed: settled with term or nak. */
const liveSource = (msg: JsMsg, logger: Logger): DeadLetterSource => ({
  subject: msg.subject,
  data: msg.data,
  headers: msg.headers,
  stream: msg.info.stream,
  streamSequence: msg.info.streamSequence,
  deliveryCount: msg.info.deliveryCount,
  timestamp: new Date(msg.info.timestampNanos / 1_000_000),
  release: async (reason) => {
    settleQuietly(logger, `Failed to term ${msg.subject}:`, () => {
      msg.term(reason);
    });
  },
  retain: () => {
    settleQuietly(logger, `Failed to nak ${msg.subject}:`, () => {
      msg.nak();
    });
  },
});

/**
 * Captures messages that exhausted their delivery limits: publishes them to
 * the DLQ stream (when configured) or hands them to the `onDeadLetter`
 * callback, then settles the original message.
 */
export class DeadLetterCapture {
  private readonly logger = new Logger('Jetstream:DeadLetter');
  /** Capture key -> when it may be forgotten. Insertion order is age order. */
  private readonly captured = new Map<string, number>();

  public constructor(
    private readonly patternRegistry: PatternRegistry,
    private readonly eventBus: EventBus,
    private readonly deadLetterConfig: DeadLetterConfig,
    private readonly otel: ResolvedOtelOptions,
    private readonly serviceName: string,
    private readonly serverEndpoint: ServerEndpoint | null,
    private readonly connection?: ConnectionProvider | undefined,
    private readonly options?: JetstreamModuleOptions | undefined,
    private readonly names?: NameResolver | undefined,
  ) {}

  /** True when this delivery is the consumer's last attempt for the message. */
  public isFinalDelivery(msg: JsMsg): boolean {
    // updateMaxDeliverMap() populates maxDeliverByStream after consumers are
    // ensured; optional chaining guards the brief startup window before then.
    // runtime lifecycle guard
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    const maxDeliver = this.deadLetterConfig.maxDeliverByStream?.get(msg.info.stream);

    if (maxDeliver === undefined || maxDeliver <= 0) return false;

    return msg.info.deliveryCount >= maxDeliver;
  }

  /** Emit the dead-letter event and route the message to the DLQ or the fallback callback. */
  public async capture(msg: JsMsg, data: unknown, error: unknown): Promise<void> {
    const source = liveSource(msg, this.logger);

    // A handler that outlived ack_wait on its final delivery may finish after
    // another replica already captured the message from the server's advisory.
    if (await this.isGone(source)) {
      await source.release('Already dead-lettered');

      return;
    }

    await this.captureSource(source, data, error);
  }

  /** Same as {@link capture}, for a message that is not a live delivery. */
  public async captureSource(
    source: DeadLetterSource,
    data: unknown,
    error: unknown,
  ): Promise<void> {
    const key = captureKey(source);

    if (!this.claim(key)) {
      await source.release('Already dead-lettered');

      return;
    }

    // A capture that keeps the message leaves it for a later report to retry.
    const msg: DeadLetterSource = {
      ...source,
      retain: () => {
        this.captured.delete(key);
        source.retain();
      },
    };

    const info: DeadLetterInfo = {
      subject: msg.subject,
      data,
      headers: msg.headers,
      error,
      deliveryCount: msg.deliveryCount,
      stream: msg.stream,
      streamSequence: msg.streamSequence,
      timestamp: msg.timestamp.toISOString(),
    };

    await withDeadLetterSpan(
      {
        msg,
        // Surface the registered pattern so APM can filter dead letters by
        // handler; falls back to the raw subject when no handler matches.
        pattern: this.patternRegistry.getHandler(msg.subject) ? msg.subject : undefined,
        finalDeliveryCount: msg.deliveryCount,
        reason: errorMessage(error),
        serviceName: this.serviceName,
        endpoint: this.serverEndpoint,
      },
      this.otel,
      async () => {
        this.eventBus.emit(TransportEvent.DeadLetter, info);

        if (!this.options || !isDlqEnabled(this.options)) {
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
  private async publishToDlq(
    msg: DeadLetterSource,
    info: DeadLetterInfo,
    error: unknown,
  ): Promise<void> {
    const serviceName = this.options?.name;

    if (!this.connection || !serviceName) {
      this.logger.error(
        `Cannot publish to DLQ for ${msg.subject}: Connection or Module Options unavailable`,
      );
      await this.fallbackToOnDeadLetterCallback(info, msg);

      return;
    }

    const dlqStreamOverride = dlqStreamOverrides(this.options).name;
    const destinationSubject = this.names
      ? this.names.dlqStreamName()
      : (dlqStreamOverride ?? dlqStreamName(serviceName));
    const hdrs = this.buildDlqHeaders(msg);

    hdrs.set(JetstreamDlqHeader.DeadLetterReason, this.extractErrorReason(error));
    hdrs.set(JetstreamDlqHeader.OriginalSubject, msg.subject);
    hdrs.set(JetstreamDlqHeader.OriginalStream, msg.stream);
    hdrs.set(JetstreamDlqHeader.FailedAt, new Date().toISOString());
    hdrs.set(JetstreamDlqHeader.DeliveryCount, msg.deliveryCount.toString());

    // One DLQ entry per stream message, even when a capture is repeated: a
    // term that never reached the server lets the message dead-letter twice.
    const msgID = captureKey(msg);

    try {
      await this.publishWithRetry(this.connection, destinationSubject, msg.data, hdrs, msgID);
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
    msgID: string,
  ): Promise<void> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= DLQ_PUBLISH_ATTEMPTS; attempt += 1) {
      try {
        await connection.getJetStreamClient().publish(subject, data, { headers, msgID });

        return;
      } catch (err) {
        lastErr = err;

        if (isStreamFull(err)) break;

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
  private buildDlqHeaders(msg: DeadLetterSource): MsgHdrs {
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

  private async notifyDeadLetterCallback(
    info: DeadLetterInfo,
    msg: DeadLetterSource,
  ): Promise<void> {
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

    await msg.release('Moved to DLQ stream');
  }

  /**
   * Last resort: invoke onDeadLetter, then release on success. On failure the
   * message stays in the stream: never redelivered past max_deliver, but preserved.
   */
  private async fallbackToOnDeadLetterCallback(
    info: DeadLetterInfo,
    msg: DeadLetterSource,
  ): Promise<void> {
    const onDeadLetter = this.deadLetterConfig.onDeadLetter;

    if (!onDeadLetter) {
      // dlq-only mode with a failed DLQ publish; keep the message in the stream.
      this.logger.error(
        `Dead letter for ${msg.subject} could not be captured (DLQ publish failed, no onDeadLetter callback); leaving the message in the stream`,
      );
      msg.retain();

      return;
    }

    try {
      await onDeadLetter(info);
    } catch (hookErr) {
      this.logger.error(
        `Fallback onDeadLetter callback failed for ${msg.subject}; the message stays in the stream and will not be redelivered (max_deliver exhausted); recover it manually:`,
        hookErr,
      );
      msg.retain();

      return;
    }

    await msg.release('Dead letter processed via fallback callback');
  }

  private claim(key: string): boolean {
    const now = Date.now();

    for (const [old, forgetAt] of this.captured) {
      if (forgetAt > now && this.captured.size < CAPTURED_MEMORY_LIMIT) break;
      this.captured.delete(old);
    }

    if (this.captured.has(key)) return false;
    this.captured.set(key, now + CAPTURED_MEMORY_MS);

    return true;
  }

  /** True only when the stream confirms the message is no longer there. */
  private async isGone(msg: DeadLetterSource): Promise<boolean> {
    if (!this.connection) return false;

    try {
      const jsm = await this.connection.getJetStreamManager();

      return (await jsm.streams.getMessage(msg.stream, { seq: msg.streamSequence })) === null;
    } catch {
      // Capturing twice is recoverable; skipping a dead letter is not.
      return false;
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
