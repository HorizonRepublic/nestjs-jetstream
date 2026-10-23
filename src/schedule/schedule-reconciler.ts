import type { ServerCapabilities } from '../connection/server-capabilities';
import { NatsCapability } from '../connection/server-capabilities.types';
import type { EventBus } from '../hooks';
import { ScheduleChange, ScheduleOrigin, StreamKind, TransportEvent } from '../interfaces';
import type { DeclaredSchedule, ScheduleReconcileReport } from '../interfaces';
import type { SubjectResolver } from '../server/infrastructure/subject-resolver';
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
  public constructor(
    private readonly writer: ScheduleWriter,
    private readonly subjects: SubjectResolver,
    private readonly capabilities: () => Promise<ServerCapabilities>,
    private readonly eventBus: EventBus,
  ) {}

  public async reconcile(declared: readonly DeclaredSchedule[]): Promise<ScheduleReconcileReport> {
    const report: ScheduleReconcileReport = { created: [], updated: [], unchanged: [] };

    if (declared.length === 0) return report;

    (await this.capabilities()).assert(NatsCapability.RecurringSchedules, usageOf(declared));

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

    this.eventBus.emit(TransportEvent.ScheduleReconciled, report);

    return report;
  }
}
