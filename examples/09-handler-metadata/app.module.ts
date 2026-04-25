import { Controller, Logger, Module } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

import { JetstreamModule } from '../../src';

@Controller()
class OrderHandler {
  private readonly logger = new Logger('Handlers');

  @EventPattern('order.created', {
    meta: { http: { method: 'POST', path: '/orders' } },
  })
  handleOrderCreated(@Payload() data: { orderId: string }): void {
    this.logger.log(`Order created: ${data.orderId}`);
  }

  @MessagePattern('order.get', {
    meta: { http: { method: 'GET', path: '/orders/:id' }, auth: 'bearer' },
  })
  handleGetOrder(@Payload() data: { id: string }): { id: string; status: string } {
    return { id: data.id, status: 'processing' };
  }

  @EventPattern('order.internal', {})
  handleInternal(@Payload() _data: unknown): void {
    // No meta — will not appear in KV bucket
  }
}

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['localhost:4222'],
    }),
  ],
  controllers: [OrderHandler],
})
export class AppModule {}
