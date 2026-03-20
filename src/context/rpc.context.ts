import { BaseRpcContext } from '@nestjs/microservices';
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
  /**
   * Get the underlying NATS message.
   *
   * @returns `JsMsg` for JetStream handlers, `Msg` for Core RPC handlers.
   */
  public getMessage(): NatsMessage {
    return this.args[0];
  }

  /** @returns The NATS subject this message was published to. */
  public getSubject(): string {
    return this.args[0].subject;
  }

  /** @returns All NATS message headers, or `undefined` if none are present. */
  public getHeaders(): MsgHdrs | undefined {
    return this.args[0].headers;
  }

  /**
   * Get a single header value by key.
   *
   * @param key - Header name (e.g. `'x-trace-id'`).
   * @returns Header value, or `undefined` if the header is missing.
   */
  public getHeader(key: string): string | undefined {
    return this.args[0].headers?.get(key);
  }

  /**
   * Type guard: returns `true` when the message is a JetStream message.
   *
   * Narrows `getMessage()` return type to `JsMsg`, giving access to
   * `ack()`, `nak()`, `term()`, and delivery metadata.
   */
  public isJetStream(): this is RpcContext & { getMessage(): JsMsg } {
    return 'ack' in this.args[0];
  }
}
