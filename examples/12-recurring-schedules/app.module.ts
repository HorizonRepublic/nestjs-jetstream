import { Controller, Get, Inject, Logger, Module, Query } from '@nestjs/common';
import { Ctx, EventPattern, Payload } from '@nestjs/microservices';

import { getClientToken, JetstreamClient, JetstreamModule, RpcContext } from '../../src';
import type { ScheduleChange, ScheduleInfo } from '../../src';

interface Reminder {
  userId: number;
}

@Controller()
class ScheduledHandlers {
  private readonly logger = new Logger('Schedules');

  /** Declared on the handler: written to NATS at boot, fired by NATS every ten seconds. */
  @EventPattern<string>('report.tick', { schedule: { cron: '*/10 * * * * *' } })
  report(@Ctx() ctx: RpcContext): void {
    this.logger.log(`Report tick, next at ${ctx.getHeader('Nats-Schedule-Next') ?? 'n/a'}`);
  }

  /** Receives the schedules a client creates at runtime. */
  @EventPattern<string>('reminder.due', { schedule: true })
  remind(@Payload() reminder: Reminder): void {
    this.logger.log(`Reminder for user ${reminder.userId}`);
  }
}

@Controller()
class HttpController {
  constructor(
    @Inject(getClientToken('scheduler'))
    private readonly client: JetstreamClient,
  ) {}

  /** Remind a user every five seconds until cancelled. */
  @Get('remind')
  async remind(@Query('user') user = '42'): Promise<ScheduleChange> {
    const userId = Number(user);

    return this.client.schedule(
      `reminder-${userId}`,
      'reminder.due',
      { userId },
      {
        everySeconds: 5,
      },
    );
  }

  @Get('cancel')
  async cancel(@Query('user') user = '42'): Promise<string> {
    await this.client.cancelSchedule(`reminder-${Number(user)}`);

    return 'cancelled';
  }

  @Get('schedules')
  async list(): Promise<ScheduleInfo[]> {
    return this.client.listSchedules();
  }
}

@Module({
  imports: [
    JetstreamModule.forRoot({ name: 'scheduler', servers: ['localhost:4222'] }),
    JetstreamModule.forFeature({ name: 'scheduler' }),
  ],
  controllers: [ScheduledHandlers, HttpController],
})
export class AppModule {}
