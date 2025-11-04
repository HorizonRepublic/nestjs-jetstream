import { BaseRpcContext } from '@nestjs/microservices/ctx-host/base-rpc.context';
import { JsMsg } from 'nats';

export type NatsJetStreamContextArgs = [JsMsg];

export class RpcContext extends BaseRpcContext<NatsJetStreamContextArgs> {
  public constructor(args: NatsJetStreamContextArgs) {
    super(args);
  }

  public get message(): JsMsg {
    return this.args[0];
  }
}
