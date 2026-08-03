import { Controller, Get, Inject, Logger, Module } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import { Observable } from 'rxjs';

import {
  getClientToken,
  JetstreamClient,
  JetstreamConnection,
  JetstreamModule,
  TransportEvent,
} from '../../src';

interface OrderPlaced {
  orderId: number;
}

interface PageViewed {
  path: string;
}

/** Bound to the default connection: no decorator, no extras. */
@Controller()
class OrdersController {
  private readonly logger = new Logger('Orders');

  // Same target service, two different clusters: the connection decides where
  // the message goes, the service name decides the subject.
  constructor(
    @Inject(getClientToken('shop'))
    private readonly primary: JetstreamClient,
    @Inject(getClientToken('shop', 'analytics'))
    private readonly analytics: JetstreamClient,
  ) {}

  @Get('place-order')
  placeOrder(): Observable<void> {
    return this.primary.emit('order.placed', { orderId: Date.now() });
  }

  @Get('track')
  track(): Observable<void> {
    return this.analytics.emit('page.viewed', { path: '/checkout' });
  }

  @EventPattern('order.placed')
  handleOrder(@Payload() data: OrderPlaced): void {
    this.logger.log(`primary cluster: order ${data.orderId}`);
  }
}

/** Every handler on this controller reads from the analytics cluster. */
@JetstreamConnection('analytics')
@Controller()
class AnalyticsController {
  private readonly logger = new Logger('Analytics');

  @EventPattern('page.viewed')
  handleView(@Payload() data: PageViewed): void {
    this.logger.log(`analytics cluster: view ${data.path}`);
  }
}

/**
 * Two NATS clusters in one service.
 *
 * `primary` is critical: the app will not start without it. `analytics` is not,
 * so stopping its container leaves the app running and only marks health as
 * degraded. Bring it back and the consumer reattaches on its own.
 */
@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'shop',
      defaultConnection: 'primary',
      hooks: {
        [TransportEvent.ConsumerRecovered]: (label, attempts, connection) => {
          new Logger('Hooks').log(
            `${connection ?? 'default'}: ${label} recovered after ${attempts}`,
          );
        },
      },
      connections: {
        primary: { servers: ['localhost:4222'] },
        analytics: {
          servers: ['localhost:4223'],
          critical: false,
          events: { concurrency: 16 },
        },
      },
    }),
    JetstreamModule.forFeature({ name: 'shop' }),
    JetstreamModule.forFeature({ name: 'shop', connection: 'analytics' }),
  ],
  controllers: [OrdersController, AnalyticsController],
})
export class AppModule {}
