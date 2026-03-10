import { BaseRpcContext } from '@nestjs/microservices/ctx-host/base-rpc.context';
import { JsMsg, MsgHdrs, Msg } from 'nats';

type NatsMessage = JsMsg | Msg;

/**
 * Execution context for RPC and event handlers.
 *
 * Provides convenient accessors for the NATS message, subject,
 * and headers without needing to interact with the raw message directly.
 *
 * @example
 * ```typescript
 * @MessagePattern('get.user')
 * getUser(data: GetUserDto, @Ctx() ctx: RpcContext) {
 *   const traceId = ctx.getHeader('x-trace-id');
 *   const subject = ctx.getSubject();
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

  /** Get all NATS message headers, or undefined if none are present. */
  public getHeaders(): MsgHdrs | undefined {
    return this.args[0].headers;
  }

  /** Get a single header value by key. Returns undefined if the header or headers object is missing. */
  public getHeader(key: string): string | undefined {
    return this.args[0].headers?.get(key);
  }

  /** Type guard: narrows getMessage() return type to JsMsg when true. */
  public isJetStream(): this is RpcContext & { getMessage(): JsMsg } {
    return 'ack' in this.args[0];
  }
}
