import { Controller, Get, Inject, Logger, Module } from '@nestjs/common';
import { Ctx, MessagePattern, Payload } from '@nestjs/microservices';
import { Observable } from 'rxjs';

import {
  getClientToken,
  JetstreamClient,
  JetstreamModule,
  JetstreamRecordBuilder,
  RpcContext,
  toNanos,
} from '../../src';

@Controller()
class PaymentController {
  private readonly logger = new Logger('Handlers');

  @MessagePattern('payment.process')
  handlePayment(
    @Payload() data: { amount: number; currency: string },
    @Ctx() ctx: RpcContext,
  ): { status: string; requestId: string | undefined } {
    const requestId = ctx.getHeader('x-request-id');

    this.logger.log(`RPC: payment.process — ${data.amount} ${data.currency} (req: ${requestId})`);

    return { status: 'processed', requestId };
  }
}

@Controller()
class HttpController {
  constructor(
    @Inject(getClientToken('payments'))
    private readonly client: JetstreamClient,
  ) {}

  /** RPC via JetStream — command persisted in stream, at-least-once delivery. */
  @Get('pay')
  pay(): Observable<unknown> {
    const record = new JetstreamRecordBuilder({ amount: 99.99, currency: 'USD' })
      .setHeader('x-request-id', `req-${Date.now()}`)
      .setTimeout(10_000)
      .build();

    return this.client.send('payment.process', record);
  }
}

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'payments',
      servers: ['localhost:4222'],
      // JetStream RPC: commands are persisted in a stream (at-least-once).
      // Response still comes via Core NATS inbox (low latency).
      rpc: {
        mode: 'jetstream',
        timeout: 30_000,
        stream: { max_age: toNanos(1, 'minutes') },
      },
    }),
    JetstreamModule.forFeature({ name: 'payments' }),
  ],
  controllers: [PaymentController, HttpController],
})
export class AppModule {}
