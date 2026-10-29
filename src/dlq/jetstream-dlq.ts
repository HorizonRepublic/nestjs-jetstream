import { Logger } from '@nestjs/common';

import {
  DeliverPolicy,
  type JetStreamManager,
  type JsMsg,
  type StreamInfo,
} from '@nats-io/jetstream';
import { headers as natsHeaders, type MsgHdrs } from '@nats-io/transport-node';

import type { ConnectionRegistry } from '../connection/connection-registry';
import type { ConnectionScope } from '../connection/connection.types';
import { ConfigErrorReason, JetstreamConfigError, toPublishError } from '../errors';
import { StreamKind } from '../interfaces';
import { JetstreamDlqHeader } from '../jetstream.constants';
import { isDlqEnabled } from '../server/infrastructure/dlq-options';
import { isNatsError, NatsErrorCode } from '../server/infrastructure/nats-error-codes';
import { errorMessage } from '../utils';
import { matchesDeadLetter } from './dead-letter-filter';
import {
  DeadLetterOrigin,
  RedriveSkipReason,
  type DeadLetterFilter,
  type DeadLetterHeaders,
  type DeadLetterRecord,
  type DlqInspectOptions,
  type DlqPurgeOptions,
  type DlqPurgeReport,
  type DlqRedriveOptions,
  type RedriveReport,
  type RedriveSkip,
} from './dlq.types';

const DEFAULT_INSPECT_LIMIT = 100;
const DEFAULT_MAX_REDRIVES = 3;
const FETCH_BATCH = 256;
const FETCH_EXPIRES_MS = 2_000;

/** Headers the DLQ adds on top of the message's own. */
const TRACKING_HEADERS: ReadonlySet<string> = new Set(
  Object.values(JetstreamDlqHeader).map((name) => name.toLowerCase()),
);

interface DeadLetterEntry {
  readonly record: DeadLetterRecord;
  readonly msg: JsMsg;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const ownHeaders = (headers: MsgHdrs | undefined): [string, string[]][] =>
  [...(headers ?? [])].filter(([name]) => !TRACKING_HEADERS.has(name.toLowerCase()));

const parseDate = (value: string): Date | undefined => {
  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

/**
 * Inspect, redrive and purge the dead-letter stream. Nothing here runs on its
 * own: an operator decides when a fix has shipped and which messages go back.
 */
export class JetstreamDlq {
  private readonly logger = new Logger('Jetstream:Dlq');

  public constructor(private readonly registry: ConnectionRegistry) {}

  /** List dead letters, oldest first. */
  public async inspect(
    filter: DeadLetterFilter = {},
    options: DlqInspectOptions = {},
  ): Promise<DeadLetterRecord[]> {
    const scope = this.scopeOf(options.connection);
    const records: DeadLetterRecord[] = [];

    for await (const { record } of this.select(
      scope,
      filter,
      options.limit ?? DEFAULT_INSPECT_LIMIT,
    )) {
      records.push(record);
    }

    return records;
  }

  /**
   * Publish dead letters back to the subject they failed on, then delete them
   * from the DLQ. A message that fails again returns to the DLQ with its
   * redrive count raised, so `maxRedrives` ends the loop.
   */
  public async redrive(
    filter: DeadLetterFilter = {},
    options: DlqRedriveOptions = {},
  ): Promise<RedriveReport> {
    const scope = this.scopeOf(options.connection);
    const dlqStream = scope.names.dlqStreamName();
    const dryRun = options.dryRun ?? false;
    const maxRedrives = options.maxRedrives ?? DEFAULT_MAX_REDRIVES;
    const gapMs = options.perSecond ? 1_000 / options.perSecond : 0;
    const redriven: number[] = [];
    const skipped: RedriveSkip[] = [];
    const notRemoved: number[] = [];
    let matched = 0;

    for await (const { record, msg } of this.select(scope, filter, options.limit)) {
      matched += 1;

      const skip = this.skipReason(record, maxRedrives);

      if (skip !== null) {
        skipped.push({ seq: record.seq, subject: record.subject, reason: skip });
        continue;
      }

      if (dryRun) {
        redriven.push(record.seq);
        continue;
      }

      try {
        await this.publishBack(scope, dlqStream, record, msg);
      } catch (err) {
        skipped.push({
          seq: record.seq,
          subject: record.subject,
          reason: RedriveSkipReason.PublishFailed,
          error: errorMessage(toPublishError(err)),
        });
        continue;
      }

      redriven.push(record.seq);

      if (!(await this.remove(scope, dlqStream, record.seq))) notRemoved.push(record.seq);
      if (gapMs > 0) await sleep(gapMs);
    }

    this.logger.log(
      `${dryRun ? 'Dry-run redrive' : 'Redrive'} on ${dlqStream}: ${matched} matched, ` +
        `${redriven.length} ${dryRun ? 'would go' : 'went'} back, ${skipped.length} skipped`,
    );

    return { dryRun, matched, redriven, skipped, notRemoved };
  }

  /** Delete dead letters for good. */
  public async purge(
    filter: DeadLetterFilter = {},
    options: DlqPurgeOptions = {},
  ): Promise<DlqPurgeReport> {
    const scope = this.scopeOf(options.connection);
    const dlqStream = scope.names.dlqStreamName();
    const dryRun = options.dryRun ?? false;
    const purged: number[] = [];

    for await (const { record } of this.select(scope, filter, options.limit)) {
      if (dryRun || (await this.remove(scope, dlqStream, record.seq))) purged.push(record.seq);
    }

    this.logger.log(
      `${dryRun ? 'Dry-run purge' : 'Purge'} on ${dlqStream}: ${purged.length} dead letters`,
    );

    return { dryRun, purged };
  }

  private scopeOf(connection: string | undefined): ConnectionScope {
    return connection === undefined ? this.registry.getDefault() : this.registry.get(connection);
  }

  private skipReason(record: DeadLetterRecord, maxRedrives: number): RedriveSkipReason | null {
    if (record.origin === DeadLetterOrigin.Broadcast) return RedriveSkipReason.Broadcast;
    if (record.redriveCount >= maxRedrives) return RedriveSkipReason.RedriveLimit;

    return null;
  }

  /**
   * Read the stream up to the last record present when the read started, so a
   * redriven message that dead-letters again is not met a second time.
   */
  private async *select(
    scope: ConnectionScope,
    filter: DeadLetterFilter,
    limit: number | undefined,
  ): AsyncGenerator<DeadLetterEntry> {
    const dlqStream = scope.names.dlqStreamName();
    const { state } = await this.dlqInfo(scope, dlqStream);
    const start = Math.max(filter.fromSeq ?? state.first_seq, state.first_seq);
    const end = Math.min(filter.toSeq ?? state.last_seq, state.last_seq);

    if (state.messages === 0 || start > end) return;

    await scope.connection.getConnection();

    const consumer = await scope.connection.getJetStreamClient().consumers.get(dlqStream, {
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: start,
    });
    let selected = 0;

    for (;;) {
      const batch = await consumer.fetch({ max_messages: FETCH_BATCH, expires: FETCH_EXPIRES_MS });
      let received = 0;

      for await (const msg of batch) {
        received += 1;

        if (msg.seq > end) return;

        const record = this.toRecord(scope, msg);

        if (matchesDeadLetter(record, filter)) {
          yield { record, msg };
          selected += 1;

          if (limit !== undefined && selected >= limit) return;
        }

        if (msg.seq === end) return;
      }

      if (received === 0) return;
    }
  }

  private async dlqInfo(scope: ConnectionScope, dlqStream: string): Promise<StreamInfo> {
    if (!isDlqEnabled(scope.options)) {
      throw new JetstreamConfigError(
        ConfigErrorReason.DlqUnavailable,
        `The dead-letter stream is turned off on connection "${scope.name}" (dlq: false).`,
      );
    }

    const jsm = await scope.connection.getJetStreamManager();

    try {
      return await jsm.streams.info(dlqStream);
    } catch (err) {
      if (!isNatsError(err, NatsErrorCode.StreamNotFound)) throw err;

      throw new JetstreamConfigError(
        ConfigErrorReason.DlqUnavailable,
        `Dead-letter stream ${dlqStream} does not exist on connection "${scope.name}". It is ` +
          'created when a service with handlers starts on that connection.',
        { cause: err },
      );
    }
  }

  private toRecord(scope: ConnectionScope, msg: JsMsg): DeadLetterRecord {
    const header = (name: JetstreamDlqHeader): string => msg.headers?.get(name) ?? '';
    const subject = header(JetstreamDlqHeader.OriginalSubject);
    const stream = header(JetstreamDlqHeader.OriginalStream);
    const headers: Record<string, string> = {};

    for (const [name, values] of ownHeaders(msg.headers)) headers[name] = values.join(', ');

    return {
      seq: msg.seq,
      subject,
      stream,
      origin: this.originOf(scope, stream),
      pattern: scope.patterns?.resolveDeclared(subject)?.pattern,
      reason: header(JetstreamDlqHeader.DeadLetterReason),
      failedAt: parseDate(header(JetstreamDlqHeader.FailedAt)),
      deliveryCount: Number(header(JetstreamDlqHeader.DeliveryCount)) || 0,
      redriveCount: Number(header(JetstreamDlqHeader.RedriveCount)) || 0,
      headers: headers satisfies DeadLetterHeaders,
      data: msg.data,
      payload: this.decode(scope, msg.data),
    };
  }

  private originOf(scope: ConnectionScope, stream: string): DeadLetterOrigin {
    if (stream === scope.names.streamName(StreamKind.Broadcast)) return DeadLetterOrigin.Broadcast;
    if (stream === scope.names.streamName(StreamKind.Schedule)) return DeadLetterOrigin.Schedule;
    if (stream === scope.names.streamName(StreamKind.Event)) return DeadLetterOrigin.Event;

    return DeadLetterOrigin.Unknown;
  }

  private decode(scope: ConnectionScope, data: Uint8Array): unknown {
    try {
      return scope.codec.decode(data);
    } catch {
      return undefined;
    }
  }

  /**
   * The message ID is the DLQ entry itself, so running a redrive again after a
   * crash between publish and delete is deduplicated by the target stream.
   */
  private async publishBack(
    scope: ConnectionScope,
    dlqStream: string,
    record: DeadLetterRecord,
    msg: JsMsg,
  ): Promise<void> {
    const headers = natsHeaders();

    for (const [name, values] of ownHeaders(msg.headers)) {
      for (const value of values) headers.append(name, value);
    }

    headers.set(JetstreamDlqHeader.RedriveCount, String(record.redriveCount + 1));

    await scope.connection.getJetStreamClient().publish(record.subject, msg.data, {
      headers,
      msgID: `dlq:${dlqStream}:${record.seq}`,
    });
  }

  private async remove(scope: ConnectionScope, dlqStream: string, seq: number): Promise<boolean> {
    const jsm: JetStreamManager = await scope.connection.getJetStreamManager();

    try {
      return await jsm.streams.deleteMessage(dlqStream, seq, false);
    } catch (err) {
      this.logger.warn(`Could not delete dead letter ${seq} from ${dlqStream}`, err);

      return false;
    }
  }
}
