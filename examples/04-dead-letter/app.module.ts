import { Controller, Get, Inject, Logger, Module } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { Observable } from 'rxjs';

import { getClientToken, JetstreamClient, JetstreamModule, toNanos } from '../../src';

// -- Handler -----------------------------------------------------------------

@Controller()
class FailingHandler {
  private readonly logger = new Logger('Handlers');

  /**
   * This handler always throws — after max_deliver attempts (3),
   * the message lands in the dead letter callback.
   */
  @EventPattern('invoice.generate')
  handleInvoice(@Payload() data: { invoiceId: number }): void {
    this.logger.warn(`Attempt to generate invoice #${data.invoiceId} — simulating failure`);

    throw new Error('PDF service unavailable');
  }
}

// -- HTTP (publish side) -----------------------------------------------------

@Controller()
class HttpController {
  constructor(
    @Inject(getClientToken('billing'))
    private readonly client: JetstreamClient,
  ) {}

  @Get('fail')
  fail(): Observable<void> {
    return this.client.emit('invoice.generate', { invoiceId: 42 });
  }
}

// -- Module ------------------------------------------------------------------

const dlqLogger = new Logger('DLQ');

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'billing',
      servers: ['localhost:4222'],
      events: {
        consumer: {
          max_deliver: 3,

          ack_wait: toNanos(2, 'seconds'),
        },
      },
      onDeadLetter: async (info) => {
        const errorMsg = info.error instanceof Error ? info.error.message : String(info.error);

        dlqLogger.error(
          `Dead letter: subject=${info.subject}, ` +
            `deliveryCount=${info.deliveryCount}, ` +
            `error=${errorMsg}`,
        );
        // In production: persist to DB, S3, or another queue
      },
    }),
    JetstreamModule.forFeature({ name: 'billing' }),
  ],
  controllers: [FailingHandler, HttpController],
})
export class AppModule {}
