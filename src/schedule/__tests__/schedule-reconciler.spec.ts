import { Logger } from '@nestjs/common';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { ServerCapabilities } from '../../connection/server-capabilities';
import { EventBus } from '../../hooks';
import { ScheduleChange, ScheduleOrigin, TransportEvent } from '../../interfaces';
import { SubjectResolver } from '../../server/infrastructure/subject-resolver';
import { ScheduleReconciler } from '../schedule-reconciler';
import { ScheduleStore } from '../schedule-store';
import { ScheduleWriter } from '../schedule-writer';

describe(ScheduleReconciler, () => {
  let writer: Mocked<ScheduleWriter>;
  let eventBus: Mocked<EventBus>;
  let store: Mocked<ScheduleStore>;
  let level: number;
  let sut: ScheduleReconciler;

  beforeEach(() => {
    level = 5;
    writer = createMock<ScheduleWriter>({
      upsert: vi.fn().mockResolvedValue(ScheduleChange.Created),
    });
    eventBus = createMock<EventBus>();
    store = createMock<ScheduleStore>({ list: vi.fn().mockResolvedValue([]) });
    sut = makeSut(SubjectResolver.forService('svc', {}));
  });

  const makeSut = (subjects: SubjectResolver): ScheduleReconciler =>
    new ScheduleReconciler(
      writer,
      store,
      subjects,
      async () => new ServerCapabilities(level, 'n1 (NATS 2.15.1)'),
      eventBus,
    );

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

  it('should report an empty reconcile for a service with dynamic schedules only', async () => {
    // When
    const report = await sut.reconcile([]);

    // Then
    expect(report).toEqual({ created: [], updated: [], unchanged: [] });
    expect(eventBus.emit).toHaveBeenCalledWith(TransportEvent.ScheduleReconciled, report);
  });

  it('should name declared schedules no handler declares when its consumer cannot see their ticks', async () => {
    // Given a custom prefix, whose consumer filters on registered patterns only
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    sut = makeSut(SubjectResolver.forService('svc', { sched: 'acme.cron' }));
    store.list.mockResolvedValue([
      {
        subject: 'acme.cron._cron.decl.old.tick',
        seq: 1,
        hash: 'h',
        writtenAt: new Date(),
        info: {
          id: 'old.tick',
          origin: ScheduleOrigin.Declared,
          pattern: 'old.tick',
          specification: '@daily',
        },
      },
    ]);

    // When
    await sut.reconcile([{ pattern: 'sync.tick', spec: { everySeconds: 60 } }]);

    // Then
    expect(store.list).toHaveBeenCalledWith(ScheduleOrigin.Declared);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/old\.tick.*acme\.cron\._cron\.decl\.old\.tick/s),
    );
    warn.mockRestore();
  });

  it('should leave undeclared holders to tick-time cleanup under the naming convention', async () => {
    // When
    await sut.reconcile([{ pattern: 'sync.tick', spec: { everySeconds: 60 } }]);

    // Then
    expect(store.list).not.toHaveBeenCalled();
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
