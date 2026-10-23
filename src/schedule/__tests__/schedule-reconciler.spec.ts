import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { ServerCapabilities } from '../../connection/server-capabilities';
import { EventBus } from '../../hooks';
import { ScheduleChange, TransportEvent } from '../../interfaces';
import { SubjectResolver } from '../../server/infrastructure/subject-resolver';
import { ScheduleReconciler } from '../schedule-reconciler';
import { ScheduleWriter } from '../schedule-writer';

describe(ScheduleReconciler, () => {
  let writer: Mocked<ScheduleWriter>;
  let eventBus: Mocked<EventBus>;
  let level: number;
  let sut: ScheduleReconciler;

  beforeEach(() => {
    level = 5;
    writer = createMock<ScheduleWriter>({
      upsert: vi.fn().mockResolvedValue(ScheduleChange.Created),
    });
    eventBus = createMock<EventBus>();
    sut = new ScheduleReconciler(
      writer,
      SubjectResolver.forService('svc', {}),
      async () => new ServerCapabilities(level, 'n1 (NATS 2.15.1)'),
      eventBus,
    );
  });

  afterEach(vi.resetAllMocks);

  it('should write every declared schedule to its holder and target', async () => {
    // When
    await sut.reconcile([{ pattern: 'sync.tick', spec: { everySeconds: 60 } }]);

    // Then
    expect(writer.upsert).toHaveBeenCalledWith(
      'svc__microservice._cron.decl.sync.tick',
      'svc__microservice.sched.sync.tick',
      'sync.tick',
      { everySeconds: 60 },
      expect.any(Date),
    );
  });

  it('should report what changed and emit it as a hook', async () => {
    // Given
    writer.upsert
      .mockResolvedValueOnce(ScheduleChange.Created)
      .mockResolvedValueOnce(ScheduleChange.Unchanged);

    // When
    const report = await sut.reconcile([
      { pattern: 'a', spec: { everySeconds: 60 } },
      { pattern: 'b', spec: { cron: '@daily' } },
    ]);

    // Then
    expect(report).toEqual({ created: ['a'], updated: [], unchanged: ['b'] });
    expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ScheduleReconciled, report);
  });

  it('should refuse before any write on a server without recurring schedules', async () => {
    // Given
    level = 3;

    // When / Then
    await expect(
      sut.reconcile([{ pattern: 'sync.tick', spec: { everySeconds: 60 } }]),
    ).rejects.toThrow(/Handler "sync.tick" needs NATS JetStream API level 4/);
    expect(writer.upsert).not.toHaveBeenCalled();
  });
});
