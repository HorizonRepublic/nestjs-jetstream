import type { MessageHandler } from '@nestjs/microservices';

import { faker } from '@faker-js/faker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamKind } from '../../../interfaces';
import type { JetstreamModuleOptions } from '../../../interfaces';
import { JetstreamScheduleError, ScheduleErrorReason } from '../../../schedule';
import { NameResolver } from '../../infrastructure/name-resolver';
import { PatternRegistry } from '../pattern-registry';

const eventHandler = (extras: Record<string, unknown>, isEvent = true): MessageHandler => {
  const handler = vi.fn() as MessageHandler;

  handler.isEventHandler = isEvent;
  handler.extras = extras;

  return handler;
};

describe('PatternRegistry with scheduled handlers', () => {
  let sut: PatternRegistry;
  let serviceName: string;

  beforeEach(() => {
    serviceName = faker.lorem.word();

    const options: JetstreamModuleOptions = {
      name: serviceName,
      servers: ['nats://localhost:4222'],
    };

    sut = new PatternRegistry(options, new NameResolver(options));
  });

  afterEach(vi.resetAllMocks);

  it('should route a handler with a schedule to the schedule stream', () => {
    // Given
    const handler = eventHandler({ schedule: { cron: '0 */10 * * * *' } });

    // When
    sut.registerHandlers(new Map([['sync.tick', handler]]));

    // Then
    expect(sut.getHandler(`${serviceName}__microservice.sched.sync.tick`)).toBe(handler);
    expect(sut.hasScheduleHandlers()).toBe(true);
    expect(sut.hasEventHandlers()).toBe(false);
    expect(sut.getScheduleSubjects()).toEqual([`${serviceName}__microservice.sched.sync.tick`]);
    expect(sut.getDeclaredSchedules()).toEqual([
      { pattern: 'sync.tick', spec: { cron: '0 */10 * * * *' } },
    ]);
    expect(sut.resolveDeclared(`${serviceName}__microservice.sched.sync.tick`)).toEqual({
      pattern: 'sync.tick',
      kind: StreamKind.Schedule,
    });
  });

  it('should route a dynamic-only handler without declaring a schedule', () => {
    // When
    sut.registerHandlers(new Map([['reminder.due', eventHandler({ schedule: true })]]));

    // Then
    expect(sut.hasScheduleHandlers()).toBe(true);
    expect(sut.getDeclaredSchedules()).toEqual([]);
    expect(sut.getPatternsByKind().schedules).toEqual(['reminder.due']);
  });

  it.each([
    ['broadcast', { broadcast: true }],
    ['ordered', { ordered: true }],
  ])('should refuse a schedule combined with %s', (_, extra) => {
    // Given
    const handler = eventHandler({ schedule: { everySeconds: 60 }, ...extra });

    // When / Then
    expect(() => {
      sut.registerHandlers(new Map([['x', handler]]));
    }).toThrow(/cannot be both/);
  });

  it('should refuse a schedule on a message pattern', () => {
    // Given an RPC handler
    const handler = eventHandler({ schedule: { everySeconds: 60 } }, false);

    // When / Then
    expect(() => {
      sut.registerHandlers(new Map([['x', handler]]));
    }).toThrow(/@EventPattern/);
  });

  it('should refuse a one-shot schedule on a handler, which every boot would fire again', () => {
    // Given
    const handler = eventHandler({ schedule: { at: new Date(Date.now() + 60_000) } });

    // When / Then
    expect(() => {
      sut.registerHandlers(new Map([['x', handler]]));
    }).toThrow(expect.objectContaining({ reason: ScheduleErrorReason.InvalidAt }));
  });

  it('should refuse an invalid schedule at registration', () => {
    // Given
    const handler = eventHandler({ schedule: { cron: '* * * * *' } });

    // When / Then
    expect(() => {
      sut.registerHandlers(new Map([['x', handler]]));
    }).toThrow(expect.objectContaining({ reason: ScheduleErrorReason.InvalidCron }));
  });

  it.each(['orders.*', 'orders.>', 'a b', 'a..b', ''])(
    'should refuse the scheduled pattern %j, which is not a literal subject',
    (pattern) => {
      // When
      const act = (): void => {
        sut.registerHandlers(new Map([[pattern, eventHandler({ schedule: true })]]));
      };

      // Then
      expect(act).toThrow(JetstreamScheduleError);
      expect(act).toThrow(expect.objectContaining({ reason: ScheduleErrorReason.InvalidPattern }));
    },
  );
});
