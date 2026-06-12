import { Logger } from '@nestjs/common';
import { JetStreamApiError, RetentionPolicy } from '@nats-io/jetstream';
import type { ConsumerInfo, StreamInfo } from '@nats-io/jetstream';

import { StreamKind } from '../../interfaces';
import type { AckExtensionConfig, JetstreamModuleOptions } from '../../interfaces';
import type { ProvisioningEntity } from '../../otel';
import { resolveAckExtensionInterval } from '../../utils/ack-extension';
import { PatternRegistry } from '../routing';

import { JetstreamProvisioningError } from './provisioning-error';
import { kindOptionsBlock, type ManagedKind } from './management';
import { NameResolver } from './name-resolver';
import { NatsErrorCode } from './nats-error-codes';
import { coversOrEquals } from './subject-utils';
import { MIGRATION_BACKUP_SUFFIX } from './stream-migration';

/** Minimal JetStreamManager surface used by the binder. */
interface BinderJsm {
  streams: { info(name: string): Promise<StreamInfo> };
  consumers: { info(stream: string, consumer: string): Promise<ConsumerInfo> };
}

const WORKQUEUE_KINDS = new Set<StreamKind>([StreamKind.Event, StreamKind.Command]);

const manualRemediation = (entity: ProvisioningEntity): string =>
  `Management mode is Manual — the ${entity} must be provisioned externally before boot.`;

const isSchedulingEnabled = (options: JetstreamModuleOptions, kind: StreamKind): boolean =>
  kindOptionsBlock(options, kind)?.stream?.allow_msg_schedules === true;

const resolveAckExtension = (
  options: JetstreamModuleOptions,
  kind: StreamKind,
): AckExtensionConfig | undefined => kindOptionsBlock(options, kind)?.ackExtension;

const filterCoversSubject = (
  /* eslint-disable @typescript-eslint/naming-convention -- NATS API uses snake_case */
  filter_subject: string | undefined,
  filter_subjects: string[] | undefined,
  /* eslint-enable @typescript-eslint/naming-convention */
  subject: string,
): boolean => {
  if (filter_subject !== undefined) {
    return coversOrEquals(filter_subject, subject);
  }

  if (filter_subjects !== undefined) {
    return filter_subjects.some((f) => coversOrEquals(f, subject));
  }

  return true;
};

/** Bind-only provisioning path: info()-only lookups and validation. */
export class InfrastructureBinder {
  private readonly logger = new Logger('Jetstream:Binder');

  public constructor(
    private readonly options: JetstreamModuleOptions,
    private readonly names: NameResolver,
    private readonly registry: PatternRegistry,
  ) {}

  public async bindStream(jsm: BinderJsm, kind: StreamKind): Promise<StreamInfo> {
    const name = this.names.streamName(kind);
    const info = await this.fetchStream(jsm, name, kind);

    await this.warnOnOrphanedMigrationBackup(jsm, name);

    if (isSchedulingEnabled(this.options, kind)) {
      this.assertScheduleCoverage(info, kind);
      this.warnOnSchedulesDisabled(info, kind);
    }

    if (WORKQUEUE_KINDS.has(kind)) {
      this.warnOnRetention(info, kind);
    }

    return info;
  }

  public async bindDlqStream(jsm: BinderJsm): Promise<StreamInfo> {
    const dlqName = this.names.dlqStreamName();
    const info = await this.fetchStream(jsm, dlqName, 'dlq');

    await this.warnOnOrphanedMigrationBackup(jsm, dlqName);
    this.assertDlqSubjectCoverage(info);

    return info;
  }

  public async bindConsumer(jsm: BinderJsm, kind: StreamKind): Promise<ConsumerInfo> {
    const info = await this.fetchConsumer(jsm, kind);

    this.assertHandlersCovered(info, kind);
    this.assertScheduleHoldersNotConsumed(info, kind);
    this.warnOnUnlimitedDelivery(info, kind);
    this.warnOnShortAckWait(info, kind);

    return info;
  }

  private async fetchStream(jsm: BinderJsm, name: string, kind: ManagedKind): Promise<StreamInfo> {
    try {
      return await jsm.streams.info(name);
    } catch (err) {
      if (
        err instanceof JetStreamApiError &&
        err.apiError().err_code === NatsErrorCode.StreamNotFound
      ) {
        const api = err.apiError();

        throw new JetstreamProvisioningError({
          entity: 'stream',
          target: name,
          kind: String(kind),
          errCode: api.err_code,
          errDescription: api.description,
          remediation: manualRemediation('stream'),
          cause: err,
        });
      }

      throw err;
    }
  }

  private async fetchConsumer(jsm: BinderJsm, kind: StreamKind): Promise<ConsumerInfo> {
    const stream = this.names.streamName(kind);
    const consumer = this.names.consumerName(kind);

    try {
      return await jsm.consumers.info(stream, consumer);
    } catch (err) {
      if (
        err instanceof JetStreamApiError &&
        err.apiError().err_code === NatsErrorCode.ConsumerNotFound
      ) {
        const api = err.apiError();

        throw new JetstreamProvisioningError({
          entity: 'consumer',
          target: `${consumer} on stream "${stream}"`,
          kind: String(kind),
          errCode: api.err_code,
          errDescription: api.description,
          remediation: manualRemediation('consumer'),
          cause: err,
        });
      }

      throw err;
    }
  }

  private assertHandlersCovered(info: ConsumerInfo, kind: StreamKind): void {
    const subjects = this.resolveHandlerSubjects(kind);

    if (subjects.length === 0) return;

    /* eslint-disable @typescript-eslint/naming-convention -- NATS API uses snake_case */
    const { filter_subject, filter_subjects } = info.config;
    /* eslint-enable @typescript-eslint/naming-convention */

    const uncovered = subjects.filter(
      (s) => !filterCoversSubject(filter_subject, filter_subjects, s),
    );

    if (uncovered.length > 0) {
      throw new Error(
        `Consumer "${this.names.consumerName(kind)}" (kind=${String(kind)}) does not cover ` +
          `the following registered handler subjects: ${uncovered.join(', ')}. ` +
          `Update the consumer's filter_subject / filter_subjects to include them.`,
      );
    }
  }

  private assertDlqSubjectCoverage(info: StreamInfo): void {
    const dlqSubject = this.names.dlqStreamName();
    const covered = info.config.subjects.some((s) => coversOrEquals(s, dlqSubject));

    if (!covered) {
      throw new Error(
        `DLQ stream "${dlqSubject}" subjects do not cover "${dlqSubject}" ` +
          `(dead letters publish to a subject equal to the stream name). ` +
          `Add it to the stream's subjects list.`,
      );
    }
  }

  private assertScheduleCoverage(info: StreamInfo, kind: StreamKind): void {
    const scheduleWildcard = `${this.names.schedulePrefix(kind)}>`;
    const covered = info.config.subjects.some((s) => coversOrEquals(s, scheduleWildcard));

    if (!covered) {
      throw new Error(
        `Stream "${this.names.streamName(kind)}" (kind=${String(kind)}) has scheduling enabled ` +
          `(allow_msg_schedules=true) but its subjects do not cover the schedule prefix ` +
          `"${this.names.schedulePrefix(kind)}". Add "${scheduleWildcard}" to the stream's subjects.`,
      );
    }
  }

  private assertScheduleHoldersNotConsumed(info: ConsumerInfo, kind: StreamKind): void {
    if (!isSchedulingEnabled(this.options, kind)) return;

    const scheduleWildcard = `${this.names.schedulePrefix(kind)}>`;

    /* eslint-disable @typescript-eslint/naming-convention -- NATS API uses snake_case */
    const { filter_subject, filter_subjects } = info.config;
    /* eslint-enable @typescript-eslint/naming-convention */
    const filters = filter_subjects ?? (filter_subject !== undefined ? [filter_subject] : []);
    const swallowing =
      filters.length === 0
        ? ['<no filter, consumes the whole stream>']
        : filters.filter((f) => coversOrEquals(f, scheduleWildcard));

    if (swallowing.length > 0) {
      throw new Error(
        `Consumer "${this.names.consumerName(kind)}" (kind=${String(kind)}) filter ` +
          `${swallowing.join(', ')} also matches the schedule namespace "${this.names.schedulePrefix(kind)}". ` +
          `Consuming schedule holders removes pending schedules from the stream. ` +
          `Use exact filter_subjects for the registered handler subjects instead.`,
      );
    }
  }

  private async warnOnOrphanedMigrationBackup(jsm: BinderJsm, streamName: string): Promise<void> {
    const backupName = `${streamName}${MIGRATION_BACKUP_SUFFIX}`;

    try {
      await jsm.streams.info(backupName);
    } catch {
      return;
    }

    this.logger.warn(
      `Found migration backup "${backupName}" for the externally managed stream "${streamName}". ` +
        `A previous Auto-managed migration was interrupted and undelivered messages may still ` +
        `reside in the backup. Recover them by sourcing the backup back, or re-enable Auto ` +
        `management for one boot to let the library finish the recovery.`,
    );
  }

  private warnOnSchedulesDisabled(info: StreamInfo, kind: StreamKind): void {
    if (info.config.allow_msg_schedules === true) return;

    this.logger.warn(
      `Stream "${this.names.streamName(kind)}" (kind=${String(kind)}) does not report ` +
        `allow_msg_schedules=true, but scheduling is enabled in the application options. ` +
        `Scheduled publishes will be rejected by the server until the stream allows message schedules.`,
    );
  }

  private warnOnRetention(info: StreamInfo, kind: StreamKind): void {
    if (info.config.retention !== RetentionPolicy.Workqueue) {
      this.logger.warn(
        `Stream "${this.names.streamName(kind)}" (kind=${String(kind)}) retention is ` +
          `"${String(info.config.retention)}" — expected "workqueue" for reliable at-least-once delivery.`,
      );
    }
  }

  private warnOnUnlimitedDelivery(info: ConsumerInfo, kind: StreamKind): void {
    if (!this.options.dlq) return;

    const maxDeliver = info.config.max_deliver;

    if (maxDeliver === undefined || maxDeliver <= 0) {
      this.logger.warn(
        `Consumer "${this.names.consumerName(kind)}" (kind=${String(kind)}) has unlimited ` +
          `max_deliver but options.dlq is enabled — messages will never be dead-lettered. ` +
          `Set max_deliver > 0 on the consumer.`,
      );
    }
  }

  private warnOnShortAckWait(info: ConsumerInfo, kind: StreamKind): void {
    const ackExtConfig = resolveAckExtension(this.options, kind);

    if (ackExtConfig === undefined || ackExtConfig === false) return;

    const ackWaitNanos = info.config.ack_wait;

    const intervalMs = resolveAckExtensionInterval(ackExtConfig, ackWaitNanos);

    if (intervalMs === null) return;

    const ackWaitMs = ackWaitNanos !== undefined ? ackWaitNanos / 1_000_000 : undefined;

    if (ackWaitMs !== undefined && ackWaitMs < intervalMs) {
      this.logger.warn(
        `Consumer "${this.names.consumerName(kind)}" (kind=${String(kind)}) ack_wait ` +
          `(${ackWaitMs}ms) is shorter than the ackExtension interval (${intervalMs}ms). ` +
          `Messages may redeliver before the handler finishes. Increase ack_wait.`,
      );
    }
  }

  private resolveHandlerSubjects(kind: StreamKind): string[] {
    const patterns = this.registry.getPatternsByKind();

    switch (kind) {
      case StreamKind.Event:
        return patterns.events.map((p) => this.names.subject(StreamKind.Event, p));
      case StreamKind.Command:
        return patterns.commands.map((p) => this.names.subject(StreamKind.Command, p));
      case StreamKind.Broadcast:
        return this.registry.getBroadcastPatterns();
      case StreamKind.Ordered:
        return this.registry.getOrderedSubjects();
      /* v8 ignore next 5 -- exhaustive switch guard, unreachable */
      default: {
        const _exhaustive: never = kind;

        throw new Error(`Unhandled StreamKind: ${String(_exhaustive)}`);
      }
    }
  }
}
