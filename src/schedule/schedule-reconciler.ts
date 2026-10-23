import { Logger } from '@nestjs/common';

import type { ServerCapabilities } from '../connection/server-capabilities';
import { NatsCapability } from '../connection/server-capabilities.types';
import type { EventBus } from '../hooks';
import { ScheduleChange, ScheduleOrigin, StreamKind, TransportEvent } from '../interfaces';
import type { DeclaredSchedule, ScheduleReconcileReport } from '../interfaces';
import type { SubjectResolver } from '../server/infrastructure/subject-resolver';
import type { ScheduleStore } from './schedule-store';
import type { ScheduleWriter } from './schedule-writer';

const usageOf = (declared: readonly DeclaredSchedule[]): string => {
  const names = declared.map((d) => `"${d.pattern}"`);

  return names.length === 1 ? `Handler ${names[0]}` : `Handlers ${names.join(', ')}`;
};

/**
 * Brings the schedule stream in line with the schedules handlers declare.
 *
 * Never deletes: a holder no handler declares may belong to a newer replica
 * mid-rollout. Orphans are cancelled when their tick finds no handler.
 */
export class ScheduleReconciler {
  private readonly logger = new Logger('Jetstream:Schedule');

  public constructor(
    private readonly writer: ScheduleWriter,
    private readonly store: ScheduleStore,
    private readonly subjects: SubjectResolver,
    private readonly capabilities: () => Promise<ServerCapabilities>,
    private readonly eventBus: EventBus,
  ) {}

  public async reconcile(declared: readonly DeclaredSchedule[]): Promise<ScheduleReconcileReport> {
    const report: ScheduleReconcileReport = { created: [], updated: [], unchanged: [] };

    if (declared.length > 0) {
      (await this.capabilities()).assert(NatsCapability.RecurringSchedules, usageOf(declared));
      await this.writeDeclared(declared, report);
    }

    if (this.subjects.hasCustomPrefix(StreamKind.Schedule)) await this.reportUndeclared(declared);

    this.eventBus.emit(TransportEvent.ScheduleReconciled, report);

    return report;
  }

  private async writeDeclared(
    declared: readonly DeclaredSchedule[],
    report: ScheduleReconcileReport,
  ): Promise<void> {
    const now = new Date();
    const holderPrefix = this.subjects.schedulePrefix(StreamKind.Schedule);

    for (const { pattern, spec } of declared) {
      const change = await this.writer.upsert(
        `${holderPrefix}${ScheduleOrigin.Declared}.${pattern}`,
        this.subjects.subject(StreamKind.Schedule, pattern),
        pattern,
        spec,
        now,
      );

      if (change === ScheduleChange.Created) report.created.push(pattern);
      else if (change === ScheduleChange.Updated) report.updated.push(pattern);
      else report.unchanged.push(pattern);
    }
  }

  /**
   * Under a custom prefix the consumer filters on registered patterns only, so
   * a removed handler's ticks never arrive to be detected as orphans. Deleting
   * here would race a rollout, so name them for an operator instead.
   */
  private async reportUndeclared(declared: readonly DeclaredSchedule[]): Promise<void> {
    const patterns = new Set(declared.map((d) => d.pattern));
    const undeclared = (await this.store.list(ScheduleOrigin.Declared)).filter(
      (holder) => !patterns.has(holder.info.pattern),
    );

    if (undeclared.length === 0) return;

    const ids = undeclared.map((h) => h.info.id).join(', ');
    const subjects = undeclared.map((h) => h.subject).join(', ');

    this.logger.warn(
      `Declared schedules with no handler in this service: ${ids}. Under a custom ` +
        'subjectPrefix their ticks never reach this service, so they are not cancelled ' +
        `automatically. Once no replica declares them, purge each holder subject: ${subjects}`,
    );
  }
}
