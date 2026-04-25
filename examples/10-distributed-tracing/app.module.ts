import { randomUUID } from 'node:crypto';

import {
  Controller,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Ctx, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { firstValueFrom, lastValueFrom } from 'rxjs';

import {
  getClientToken,
  JetstreamClient,
  JetstreamModule,
  JetstreamTrace,
  RpcContext,
} from '../../src';

import { sdk } from './tracing';

const SERVICE = 'tracing-demo';

/**
 * Flushes pending spans through the configured exporter when Nest tears
 * the application down. Wired into the standard `OnApplicationShutdown`
 * lifecycle so the JetStream transport's own drain logic still runs first.
 */
@Injectable()
class OtelLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('OtelLifecycle');

  public async onApplicationShutdown(): Promise<void> {
    try {
      await sdk.shutdown();
    } catch (err) {
      this.logger.error('OTel SDK shutdown failed', err);
    }
  }
}

@Controller()
class OrdersController {
  private readonly logger = new Logger('OrdersController');

  /**
   * RPC handler — receives an order placement request, simulates an
   * inventory check, returns a result. The CONSUMER span produced here
   * is linked as a child of the upstream CLIENT span via traceparent.
   */
  @MessagePattern('orders.place')
  async placeOrder(
    @Payload() data: { readonly sku: string; readonly qty: number },
    @Ctx() ctx: RpcContext,
  ): Promise<{ readonly ok: true; readonly orderId: string }> {
    this.logger.log(`Placing order — sku=${data.sku} qty=${data.qty} subject=${ctx.getSubject()}`);
    // Simulate downstream work — any handler-level await keeps the
    // active span context alive thanks to AsyncLocalStorageContextManager
    await new Promise((r) => setTimeout(r, 25));

    return { ok: true, orderId: `ord-${randomUUID()}` };
  }

  /**
   * Event handler — fires after every successful order placement.
   * Each delivery produces a CONSUMER span linked to the publish span
   * via the traceparent header.
   */
  @EventPattern('orders.placed')
  async onOrderPlaced(@Payload() data: { readonly orderId: string }): Promise<void> {
    this.logger.log(`Audit: order placed (${data.orderId})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

@Controller()
class HttpController {
  private readonly logger = new Logger('HttpController');

  public constructor(
    @Inject(getClientToken(SERVICE))
    private readonly client: JetstreamClient,
  ) {}

  /**
   * GET / triggers one full distributed trace:
   * - HTTP request (instrumented by the OTel auto-instrumentations if you
   *   add `@opentelemetry/auto-instrumentations-node`)
   * - RPC `orders.place` (CLIENT span on this side, CONSUMER span on the handler)
   * - Event `orders.placed` (PRODUCER span here, CONSUMER span on the handler)
   *
   * Watch the console — every span prints with its `traceId`, `spanId`,
   * `parentSpanId`, kind, and attributes. Same `traceId` across the chain
   * means the trace is intact end-to-end.
   */
  @Get()
  async place(): Promise<{ readonly orderId: string }> {
    const result = await firstValueFrom(
      this.client.send<{ readonly orderId: string; readonly ok: true }>('orders.place', {
        sku: 'WIDGET-1',
        qty: 1,
      }),
    );

    // `emit()` returns a cold Observable — without `lastValueFrom` the
    // publish (and its PRODUCER span) never fires. The full round-trip
    // for the demo depends on this actually hitting NATS.
    await lastValueFrom(this.client.emit('orders.placed', { orderId: result.orderId }));
    this.logger.log(`Replied with ${result.orderId}`);

    return { orderId: result.orderId };
  }
}

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: SERVICE,
      servers: ['nats://localhost:4222'],
      otel: {
        // Default trace set is fine — but flip on the connection lifecycle
        // span so you can see the connect/disconnect pattern in your APM too.
        traces: [
          JetstreamTrace.Publish,
          JetstreamTrace.Consume,
          JetstreamTrace.RpcClientSend,
          JetstreamTrace.DeadLetter,
          JetstreamTrace.ConnectionLifecycle,
        ],
      },
    }),
    JetstreamModule.forFeature({ name: SERVICE }),
  ],
  controllers: [OrdersController, HttpController],
  providers: [OtelLifecycle],
})
export class AppModule {}
