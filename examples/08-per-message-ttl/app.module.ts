import { Controller, Get, Inject, Logger, Module } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';

import {
  getClientToken,
  JetstreamClient,
  JetstreamModule,
  JetstreamRecordBuilder,
  toNanos,
} from '../../src';

// -- Handler -----------------------------------------------------------------

@Controller()
class SessionHandler {
  private readonly logger = new Logger('Handlers');

  @EventPattern('session.token')
  handleToken(@Payload() data: { token: string; userId: number }): void {
    this.logger.log(`Session token received: user=${data.userId}`);
  }
}

// -- HTTP (publish side) -----------------------------------------------------

@Controller()
class HttpController {
  private readonly logger = new Logger('HTTP');

  constructor(
    @Inject(getClientToken('auth'))
    private readonly client: JetstreamClient,
  ) {}

  /** Publish a session token that auto-expires after 30 seconds. */
  @Get('token')
  async token(): Promise<string> {
    const record = new JetstreamRecordBuilder({
      token: crypto.randomUUID(),
      userId: 42,
    })
      .ttl(toNanos(30, 'seconds'))
      .build();

    await lastValueFrom(this.client.emit('session.token', record));

    this.logger.log('Published session token with 30s TTL');

    return 'Published — message will expire from stream after 30 seconds';
  }
}

// -- Module (requires NATS >= 2.11) ------------------------------------------

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'auth',
      servers: ['localhost:4222'],
      events: {
        stream: { allow_msg_ttl: true },
      },
    }),
    JetstreamModule.forFeature({ name: 'auth' }),
  ],
  controllers: [SessionHandler, HttpController],
})
export class AppModule {}
