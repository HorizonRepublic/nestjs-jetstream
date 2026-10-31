import { Controller, Get, Inject, Logger, Module } from '@nestjs/common';
import { Ctx, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

import { Observable } from 'rxjs';

import { getClientToken, JetstreamClient, JetstreamModule, RpcContext } from '../../src';

interface OrderRequest {
  id: number;
}

interface OrderReply {
  pattern: string;
  subject: string;
  id: number;
}

@Controller()
class WildcardController {
  private readonly logger = new Logger('WildcardHandlers');

  // Matches exactly one token: orders.created, orders.cancelled, etc.
  @MessagePattern('orders.*')
  handleOrder(@Payload() data: OrderRequest, @Ctx() ctx: RpcContext): OrderReply {
    return { pattern: 'orders.*', subject: ctx.getSubject(), id: data.id };
  }

  // Exact matches take precedence, regardless of registration order.
  @MessagePattern('orders.special')
  handleSpecialOrder(@Payload() data: OrderRequest, @Ctx() ctx: RpcContext): OrderReply {
    return { pattern: 'orders.special', subject: ctx.getSubject(), id: data.id };
  }

  // Matches one or more trailing tokens; does not match the bare "audit" subject.
  @EventPattern<string>('audit.>')
  handleAudit(@Payload() data: OrderRequest, @Ctx() ctx: RpcContext): void {
    this.logger.log(`audit.> matched ${ctx.getSubject()} (order=${data.id})`);
  }
}

@Controller()
class HttpController {
  constructor(
    @Inject(getClientToken('wildcards'))
    private readonly client: JetstreamClient,
  ) {}

  // Publishers always use concrete subjects, never wildcard patterns.
  @Get('rpc')
  rpc(): Observable<OrderReply> {
    return this.client.send('orders.created', { id: 42 });
  }

  @Get('exact')
  exact(): Observable<OrderReply> {
    return this.client.send('orders.special', { id: 42 });
  }

  @Get('event')
  event(): Observable<void> {
    return this.client.emit('audit.eu.orders.created', { id: 42 });
  }
}

@Module({
  imports: [
    JetstreamModule.forRoot({ name: 'wildcards', servers: ['localhost:4222'] }),
    JetstreamModule.forFeature({ name: 'wildcards' }),
  ],
  controllers: [WildcardController, HttpController],
})
export class AppModule {}
