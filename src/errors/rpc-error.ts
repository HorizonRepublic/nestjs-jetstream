import type { RpcErrorReason } from './errors.types';
import { JetstreamError } from './jetstream-error';

/** An RPC call or its settlement was rejected. */
export class JetstreamRpcError extends JetstreamError<RpcErrorReason> {
  public constructor(reason: RpcErrorReason, message: string, options?: ErrorOptions) {
    super(reason, message, options);
    this.name = 'JetstreamRpcError';
  }
}
