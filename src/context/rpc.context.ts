import { BaseRpcContext } from '@nestjs/microservices/ctx-host/base-rpc.context';
import { JsMsg, Msg } from 'nats';

type NatsMessage = JsMsg | Msg;

/**
 * Execution context for RPC and event handlers.
 *
 * Provides access to the raw NATS message for advanced use cases
 * (reading headers, manual ack/nak, etc.).
 *
 * @example
 * ```typescript
 * @MessagePattern('get.user')
 * getUser(data: GetUserDto, @Ctx() ctx: RpcContext) {
 *   const msg = ctx.getMessage();
 *   const traceId = msg.headers?.get('x-trace-id');
 *   return this.userService.findOne(data.id);
 * }
 * ```
 */
export class RpcContext extends BaseRpcContext<[NatsMessage]> {
  /** Get the underlying NATS message (JsMsg for JetStream, Msg for Core). */
  public getMessage(): NatsMessage {
    return this.args[0];
  }

  /** Get the NATS subject this message was published to. */
  public getSubject(): string {
    return this.args[0].subject;
  }
}
