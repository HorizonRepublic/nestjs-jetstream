import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

import { RpcContext } from '../src';

/**
 * Microservice controller demonstrating handler patterns.
 *
 * - `@EventPattern` — workqueue events (at-least-once, ack after handler)
 * - `@EventPattern` with `{ broadcast: true }` — broadcast events (all consumers receive)
 * - `@MessagePattern` — RPC commands (request/reply)
 */
@Controller()
export class AppMicroserviceController {
  private readonly logger = new Logger(AppMicroserviceController.name);

  /** Handle a workqueue event. Acked automatically after successful execution. */
  @EventPattern('user.created')
  public handleUserCreated(@Payload() payload: { userId: number; email: string }): void {
    this.logger.log(`User created: ${payload.userId} (${payload.email})`);
  }

  /** Handle a broadcast event. All running instances receive this. */
  @EventPattern('config.updated', { broadcast: true })
  public handleConfigUpdated(@Payload() payload: { key: string; value: string }): void {
    this.logger.log(`Config updated: ${payload.key} = ${payload.value}`);
  }

  /** Handle an RPC command. Return value is sent back to the caller. */
  @MessagePattern('user.get')
  public handleGetUser(
    @Payload() payload: { id: number },
    @Ctx() ctx: RpcContext,
  ): { id: number; name: string } {
    this.logger.log(`RPC: user.get (id=${payload.id}), subject: ${ctx.getSubject()}`);

    return { id: payload.id, name: 'John Doe' };
  }
}
