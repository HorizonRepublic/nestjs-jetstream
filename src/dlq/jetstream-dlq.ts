import { Logger } from '@nestjs/common';

import {
  DeliverPolicy,
  type ConsumerConfig,
  type JetStreamManager,
  type JsMsg,
  type StreamInfo,
} from '@nats-io/jetstream';
import { headers as natsHeaders, type MsgHdrs } from '@nats-io/transport-node';

import type { ConnectionRegistry } from '../connection/connection-registry';
import type { ConnectionScope } from '../connection/connection.types';
import { ConfigErrorReason, JetstreamConfigError, toPublishError } from '../errors';
import { StreamKind } from '../interfaces';
import { JetstreamDlqHeader, NATS_CONTROL_HEADER_PREFIX } from '../jetstream.constants';
import { isDlqEnabled } from '../server/infrastructure/dlq-options';
import { isNatsError, NatsErrorCode } from '../server/infrastructure/nats-error-codes';
import { coversOrEquals } from '../server/infrastructure/subject-utils';
import { errorMessage } from '../utils';
import { isValidFilter, matchesDeadLetter, setsAnyCriterion } from './dead-letter-filter';
import {
  DeadLetterOrigin,
  DlqRedriveSkipReason,
  type DeadLetterFilter,
  type DeadLetterRecord,
  type DlqInspectOptions,
  type DlqPurgeAllOptions,
  type DlqPurgeOptions,
  type DlqPurgeReport,
  type DlqRedriveOptions,
  type DlqRedriveReport,
  type DlqRedriveSkip,
} from './dlq.types';

const DEFAULT_INSPECT_LIMIT = 100;
const DEFAULT_MAX_REDRIVES = 3;
const FETCH_BATCH = 256;
const FETCH_EXPIRES_MS = 2_000;
const DELETE_BATCH = 64;

/** Headers the DLQ adds on top of the message's own. */
const TRACKING_HEADERS: ReadonlySet<string> = new Set(
  Object.values(JetstreamDlqHeader).map((name) => name.toLowerCase()),
);

const STREAM_KIND_OF: ReadonlyMap<DeadLetterOrigin, StreamKind> = new Map([
  [DeadLetterOrigin.Event, StreamKind.Event],
  [DeadLetterOrigin.Broadcast, StreamKind.Broadcast],
  [DeadLetterOrigin.Schedule, StreamKind.Schedule],
]);

type HeaderEntry = [string, string[]];

/** Filter subjects of a durable consumer, or `null` when it does not exist. */
type ConsumerFilters = readonly string[] | null;

interface DeadLetterEntry {
  readonly record: DeadLetterRecord;
  readonly msg: JsMsg;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const ownHeaders = (headers: MsgHdrs | undefined): HeaderEntry[] =>
  [...(headers ?? [])].filter(([name]) => !TRACKING_HEADERS.has(name.toLowerCase()));

const parseDate = (value: string): Date | undefined => {
  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const assertValidFilter = (filter: DeadLetterFilter): void => {
  if (isValidFilter(filter)) return;

  throw new JetstreamConfigError(
    ConfigErrorReason.DlqFilterInvalid,
    'DLQ filter sequence bounds must be non-negative integers and its dates valid.',
  );
};

const filtersOf = (config: ConsumerConfig): string[] => {
  if (config.filter_subjects?.length) return config.filter_subjects;
  if (config.filter_subject) return [config.filter_subject];

  return ['>'];
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
    assertValidFilter(filter);

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
  ): Promise<DlqRedriveReport> {
    assertValidFilter(filter);

    const scope = this.scopeOf(options.connection);
    const dlqStream = scope.names.dlqStreamName();
    const dryRun = options.dryRun ?? false;
    const maxRedrives = options.maxRedrives ?? DEFAULT_MAX_REDRIVES;
    const gapMs = options.perSecond ? 1_000 / options.perSecond : 0;
    const consumers = new Map<StreamKind, ConsumerFilters>();
    const redriven: number[] = [];
    const skipped: DlqRedriveSkip[] = [];
    const notRemoved: number[] = [];
    let matched = 0;

    for await (const { record, msg } of this.select(scope, filter, options.limit)) {
      matched += 1;

      const skip = await this.skipReason(scope, record, maxRedrives, consumers);

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
        redriven.push(record.seq);

        if (!(await this.remove(scope, dlqStream, record.seq))) notRemoved.push(record.seq);
      } catch (err) {
        skipped.push({
          seq: record.seq,
          subject: record.subject,
          reason: DlqRedriveSkipReason.PublishFailed,
          error: errorMessage(toPublishError(err)),
        });
      }

      if (gapMs > 0) await sleep(gapMs);
    }

    this.logger.log(
      `${dryRun ? 'Dry-run redrive' : 'Redrive'} on ${dlqStream}: ${matched} matched, ` +
        `${redriven.length} ${dryRun ? 'would go' : 'went'} back, ${skipped.length} skipped`,
    );

    return { dryRun, matched, redriven, skipped, notRemoved };
  }

  /**
   * Delete the dead letters a filter selects. The filter must set at least one
   * criterion: emptying the whole DLQ is {@link purgeAll}. An upper sequence
   * bound alone is purged by the server in one call; every other filter reads
   * headers, so its matches are deleted in batches.
   */
  public async purge(
    filter: DeadLetterFilter,
    options: DlqPurgeOptions = {},
  ): Promise<DlqPurgeReport> {
    if (!setsAnyCriterion(filter)) {
      throw new JetstreamConfigError(
        ConfigErrorReason.DlqFilterRequired,
        'purge() needs a filter with at least one criterion. To empty the whole DLQ, call purgeAll().',
      );
    }

    assertValidFilter(filter);

    const scope = this.scopeOf(options.connection);
    const dlqStream = scope.names.dlqStreamName();
    const dryRun = options.dryRun ?? false;
    const purged =
      (!dryRun && options.limit === undefined
        ? await this.purgeHead(scope, dlqStream, filter)
        : null) ?? (await this.purgeMatches(scope, dlqStream, filter, options.limit, dryRun));

    this.logPurge(dryRun, dlqStream, purged);

    return { dryRun, purged };
  }

  /** Empty the whole dead-letter stream in one server call. */
  public async purgeAll(options: DlqPurgeAllOptions = {}): Promise<DlqPurgeReport> {
    const scope = this.scopeOf(options.connection);
    const dlqStream = scope.names.dlqStreamName();
    const dryRun = options.dryRun ?? false;
    const { state } = await this.dlqInfo(scope, dlqStream);
    const purged = dryRun
      ? state.messages
      : (await (await scope.connection.getJetStreamManager()).streams.purge(dlqStream)).purged;

    this.logPurge(dryRun, dlqStream, purged);

    return { dryRun, purged };
  }

  private scopeOf(connection: string | undefined): ConnectionScope {
    return connection === undefined ? this.registry.getDefault() : this.registry.get(connection);
  }

  private async skipReason(
    scope: ConnectionScope,
    record: DeadLetterRecord,
    maxRedrives: number,
    consumers: Map<StreamKind, ConsumerFilters>,
  ): Promise<DlqRedriveSkipReason | null> {
    if (record.origin === DeadLetterOrigin.Broadcast) return DlqRedriveSkipReason.Broadcast;
    if (record.origin === DeadLetterOrigin.Schedule) return DlqRedriveSkipReason.ScheduleTick;
    if (record.redriveCount >= maxRedrives) return DlqRedriveSkipReason.RedriveLimit;

    const kind = STREAM_KIND_OF.get(record.origin);

    if (kind === undefined) return DlqRedriveSkipReason.NoConsumer;

    if (!consumers.has(kind)) consumers.set(kind, await this.consumerFilters(scope, kind));

    const filters = consumers.get(kind);

    return filters?.some((f) => coversOrEquals(f, record.subject))
      ? null
      : DlqRedriveSkipReason.NoConsumer;
  }

  /** Read from the server, so it holds even where no handler is registered in this process. */
  private async consumerFilters(
    scope: ConnectionScope,
    kind: StreamKind,
  ): Promise<ConsumerFilters> {
    const jsm = await scope.connection.getJetStreamManager();

    try {
      const info = await jsm.consumers.info(
        scope.names.streamName(kind),
        scope.names.consumerName(kind),
      );

      return filtersOf(info.config);
    } catch (err) {
      if (
        isNatsError(err, NatsErrorCode.ConsumerNotFound) ||
        isNatsError(err, NatsErrorCode.StreamNotFound)
      ) {
        return null;
      }

      throw err;
    }
  }

  private async *select(
    scope: ConnectionScope,
    filter: DeadLetterFilter,
    limit: number | undefined,
  ): AsyncGenerator<DeadLetterEntry> {
    if (limit !== undefined && limit <= 0) return;

    let selected = 0;

    for await (const msg of this.read(scope, filter)) {
      const record = this.toRecord(scope, msg);

      if (!matchesDeadLetter(record, filter)) continue;

      yield { record, msg };
      selected += 1;

      if (limit !== undefined && selected >= limit) return;
    }
  }

  /**
   * Every entry in the filter's sequence range, up to the last one present
   * when the read started, so a redriven message that dead-letters again is
   * not met a second time.
   */
  private async *read(scope: ConnectionScope, filter: DeadLetterFilter): AsyncGenerator<JsMsg> {
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

    try {
      for (;;) {
        const batch = await consumer.fetch({
          max_messages: FETCH_BATCH,
          expires: FETCH_EXPIRES_MS,
        });
        let received = 0;

        for await (const msg of batch) {
          received += 1;

          if (msg.seq > end) return;

          yield msg;

          // The newest entries may be gone since the snapshot; stop once nothing is left.
          if (msg.seq === end || msg.info.pending === 0) return;
        }

        if (received === 0) return;
      }
    } finally {
      await consumer.delete().catch(() => undefined);
    }
  }

  /**
   * Server-side purge of everything up to `toSeq`. Only possible when that
   * bound is the whole filter, or a lower bound that spares nothing joins it.
   */
  private async purgeHead(
    scope: ConnectionScope,
    dlqStream: string,
    filter: DeadLetterFilter,
  ): Promise<number | null> {
    const { fromSeq, toSeq, ...criteria } = filter;

    // A seq the server cannot read as one (NaN, 0) makes it purge everything.
    if (toSeq === undefined || !Number.isSafeInteger(toSeq) || toSeq < 0) return null;
    if (setsAnyCriterion(criteria)) return null;

    const { state } = await this.dlqInfo(scope, dlqStream);

    if (fromSeq !== undefined && fromSeq > state.first_seq) return null;

    const jsm = await scope.connection.getJetStreamManager();

    return (await jsm.streams.purge(dlqStream, { seq: toSeq + 1 })).purged;
  }

  private async purgeMatches(
    scope: ConnectionScope,
    dlqStream: string,
    filter: DeadLetterFilter,
    limit: number | undefined,
    dryRun: boolean,
  ): Promise<number> {
    let purged = 0;
    let batch: number[] = [];

    for await (const { record } of this.select(scope, filter, limit)) {
      batch.push(record.seq);

      if (batch.length < DELETE_BATCH) continue;

      purged += dryRun ? batch.length : await this.removeAll(scope, dlqStream, batch);
      batch = [];
    }

    return purged + (dryRun ? batch.length : await this.removeAll(scope, dlqStream, batch));
  }

  private logPurge(dryRun: boolean, dlqStream: string, purged: number): void {
    this.logger.log(
      `${dryRun ? 'Dry-run purge' : 'Purge'} on ${dlqStream}: ${purged} dead letters`,
    );
  }

  private async removeAll(
    scope: ConnectionScope,
    dlqStream: string,
    seqs: number[],
  ): Promise<number> {
    const removed = await Promise.all(seqs.map((seq) => this.remove(scope, dlqStream, seq)));

    return removed.filter(Boolean).length;
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
    const origin = this.originOf(scope, header(JetstreamDlqHeader.OriginalStream), subject);

    return {
      seq: msg.seq,
      subject,
      stream: header(JetstreamDlqHeader.OriginalStream),
      origin,
      pattern: this.patternOf(scope, origin, subject),
      reason: header(JetstreamDlqHeader.DeadLetterReason),
      failedAt: parseDate(header(JetstreamDlqHeader.FailedAt)),
      deliveryCount: Number(header(JetstreamDlqHeader.DeliveryCount)) || 0,
      redriveCount: Number(header(JetstreamDlqHeader.RedriveCount)) || 0,
      headers: Object.fromEntries(ownHeaders(msg.headers)),
      data: msg.data,
      payload: this.decode(scope, msg.data),
    };
  }

  private originOf(scope: ConnectionScope, stream: string, subject: string): DeadLetterOrigin {
    for (const [origin, kind] of STREAM_KIND_OF) {
      if (stream === scope.names.streamName(kind)) return origin;
    }

    // A renamed broadcast stream still carries the global broadcast subject.
    if (subject.startsWith(scope.names.subject(StreamKind.Broadcast, ''))) {
      return DeadLetterOrigin.Broadcast;
    }

    return DeadLetterOrigin.Unknown;
  }

  /**
   * The declared pattern when handlers are registered in this process,
   * otherwise derived from the subject: a script or an admin-only app
   * registers none.
   */
  private patternOf(
    scope: ConnectionScope,
    origin: DeadLetterOrigin,
    subject: string,
  ): string | undefined {
    const declared = scope.patterns?.resolveDeclared(subject)?.pattern;

    if (declared !== undefined) return declared;

    const kind = STREAM_KIND_OF.get(origin);

    if (kind === undefined) return undefined;

    const prefix = scope.names.subject(kind, '');

    return subject.startsWith(prefix) ? subject.slice(prefix.length) : undefined;
  }

  private decode(scope: ConnectionScope, data: Uint8Array): unknown {
    try {
      return scope.codec.decode(data);
    } catch {
      return undefined;
    }
  }

  /**
   * The message ID names the DLQ entry, its stored time included, so a rerun
   * after a crash between publish and delete is deduplicated by the target
   * stream, while an entry that reuses a sequence of a recreated DLQ is not.
   */
  private async publishBack(
    scope: ConnectionScope,
    dlqStream: string,
    record: DeadLetterRecord,
    msg: JsMsg,
  ): Promise<void> {
    const headers = natsHeaders();

    for (const [name, values] of ownHeaders(msg.headers)) {
      if (name.toLowerCase().startsWith(NATS_CONTROL_HEADER_PREFIX)) continue;

      for (const value of values) headers.append(name, value);
    }

    headers.set(JetstreamDlqHeader.RedriveCount, String(record.redriveCount + 1));

    await scope.connection.getJetStreamClient().publish(record.subject, msg.data, {
      headers,
      msgID: `dlq:${dlqStream}:${record.seq}:${msg.info.timestampNanos}`,
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
