import { Controller, Get, Inject, Logger, Module } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';

import {
  getClientToken,
  JetstreamClient,
  JetstreamModule,
  JetstreamRecordBuilder,
} from '../../src';

@Controller()
class ReminderHandler {
  private readonly logger = new Logger('Handlers');

  /** Receives the event at the scheduled time, not when it was published. */
  @EventPattern('reminder.send')
  handleReminder(@Payload() data: { userId: number; message: string }): void {
    this.logger.log(`Reminder delivered: user=${data.userId} — "${data.message}"`);
  }
}

@Controller()
class HttpController {
  private readonly logger = new Logger('HTTP');

  constructor(
    @Inject(getClientToken('notifications'))
    private readonly client: JetstreamClient,
  ) {}

  /** Schedule a reminder 10 seconds from now. */
  @Get('schedule')
  async schedule(): Promise<string> {
    const deliverAt = new Date(Date.now() + 10_000);

    const record = new JetstreamRecordBuilder({
      userId: 42,
      message: 'Your trial expires tomorrow',
    })
      .scheduleAt(deliverAt)
      .build();

    await lastValueFrom(this.client.emit('reminder.send', record));

    this.logger.log(`Scheduled reminder for ${deliverAt.toISOString()}`);

    return `Scheduled — will deliver at ${deliverAt.toISOString()}`;
  }
}

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'notifications',
      servers: ['localhost:4222'],
      events: {
        stream: {
          allow_msg_schedules: true,
        },
      },
    }),
    JetstreamModule.forFeature({ name: 'notifications' }),
  ],
  controllers: [ReminderHandler, HttpController],
})
export class AppModule {}
