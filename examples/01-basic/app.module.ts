import { Controller, Get, Inject, Logger, Module } from '@nestjs/common';
import { Ctx, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { Observable } from 'rxjs';

import { getClientToken, JetstreamClient, JetstreamModule, RpcContext } from '../../src';

@Controller()
class EventController {
  private readonly logger = new Logger('Handlers');

  @EventPattern('user.created')
  handleUserCreated(@Payload() data: { userId: number; email: string }): void {
    this.logger.log(`Event: user.created — ${data.userId} (${data.email})`);
  }

  @EventPattern('config.updated', { broadcast: true })
  handleBroadcast(@Payload() data: { key: string; value: string }): void {
    this.logger.log(`Broadcast: ${data.key} = ${data.value}`);
  }

  @MessagePattern('user.get')
  handleRpc(@Payload() data: { id: number }, @Ctx() ctx: RpcContext): { id: number; name: string } {
    this.logger.log(`RPC: user.get (id=${data.id}, subject=${ctx.getSubject()})`);

    return { id: data.id, name: 'John Doe' };
  }
}

@Controller()
class HttpController {
  constructor(
    @Inject(getClientToken('basic'))
    private readonly client: JetstreamClient,
  ) {}

  @Get('emit')
  emit(): Observable<void> {
    return this.client.emit('user.created', { userId: 42, email: 'user@example.com' });
  }

  @Get('broadcast')
  broadcast(): Observable<void> {
    return this.client.emit('broadcast:config.updated', { key: 'theme', value: 'dark' });
  }

  @Get('rpc')
  rpc(): Observable<unknown> {
    return this.client.send('user.get', { id: 1 });
  }
}

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'basic',
      servers: ['localhost:4222'],
    }),
    JetstreamModule.forFeature({ name: 'basic' }),
  ],
  controllers: [EventController, HttpController],
})
export class AppModule {}
