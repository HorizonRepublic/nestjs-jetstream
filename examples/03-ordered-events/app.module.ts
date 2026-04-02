import { Controller, Get, Inject, Logger, Module } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';

import { getClientToken, JetstreamClient, JetstreamModule } from '../../src';

// -- Handler -----------------------------------------------------------------

@Controller()
class OrderProjection {
  private readonly logger = new Logger('Projection');

  /** Ordered events arrive in strict sequence — ideal for projections / read models. */
  @EventPattern('order.status-changed', { ordered: true })
  handleStatusChange(@Payload() data: { orderId: number; status: string; seq: number }): void {
    this.logger.log(`Order #${data.orderId}: ${data.status} (seq=${data.seq})`);
  }
}

// -- HTTP (publish side) -----------------------------------------------------

@Controller()
class HttpController {
  private readonly logger = new Logger('HTTP');

  constructor(
    @Inject(getClientToken('orders'))
    private readonly client: JetstreamClient,
  ) {}

  /** Publishes 5 sequential status changes — handler receives them in order. */
  @Get('sequence')
  async sequence(): Promise<string> {
    const statuses = ['created', 'paid', 'shipped', 'delivered', 'completed'];

    for (let i = 0; i < statuses.length; i++) {
      await lastValueFrom(
        this.client.emit(`ordered:order.status-changed`, {
          orderId: 1,
          status: statuses[i],
          seq: i + 1,
        }),
      );
    }

    this.logger.log('Published 5 ordered events');

    return 'OK — check console for sequential delivery';
  }
}

// -- Module ------------------------------------------------------------------

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'orders',
      servers: ['localhost:4222'],
    }),
    JetstreamModule.forFeature({ name: 'orders' }),
  ],
  controllers: [OrderProjection, HttpController],
})
export class AppModule {}
