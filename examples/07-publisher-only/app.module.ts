import { Controller, Get, Inject, Logger, Module } from '@nestjs/common';
import { Observable } from 'rxjs';

import { getClientToken, JetstreamClient, JetstreamModule } from '../../src';

@Controller()
class GatewayController {
  private readonly logger = new Logger('Gateway');

  constructor(
    @Inject(getClientToken('orders'))
    private readonly ordersClient: JetstreamClient,
  ) {}

  @Get('place-order')
  placeOrder(): Observable<void> {
    this.logger.log('Publishing order.placed event');

    return this.ordersClient.emit('order.placed', {
      orderId: Date.now(),
      items: [{ sku: 'WIDGET-1', qty: 2 }],
    });
  }
}

/**
 * Publisher-only mode: `consumer: false` skips all stream/consumer
 * infrastructure. The app only publishes — no handlers, no streams.
 *
 * Typical use case: API gateway, BFF, or cron service that
 * dispatches events to downstream microservices.
 */
@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'gateway',
      servers: ['localhost:4222'],
      consumer: false,
    }),
    JetstreamModule.forFeature({ name: 'orders' }),
  ],
  controllers: [GatewayController],
})
export class AppModule {}
