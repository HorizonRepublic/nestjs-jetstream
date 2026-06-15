import type { Logger } from '@nestjs/common';
import type { JsMsg } from '@nats-io/jetstream';

import type { RpcContext } from '../../context';
import type { HandlerStatus } from '../../interfaces';
import { settleQuietly } from '../../utils';

import type { DeadLetterCapture } from './dead-letter-capture';
import type { Settlement } from './routing.types';

/** Order mirrors settleSuccess: explicit terminate() wins over retry(). */
export const statusForContext = (ctx: RpcContext): HandlerStatus => {
  if (ctx.shouldTerminate) return 'terminated';
  if (ctx.shouldRetry) return 'retried';

  return 'success';
};

export const createSettlement = (logger: Logger, capture: DeadLetterCapture | null): Settlement => {
  const settleSuccess = (msg: JsMsg, ctx: RpcContext, data: unknown): Promise<void> | undefined => {
    if (ctx.shouldTerminate) {
      settleQuietly(logger, `Failed to term ${msg.subject}:`, () => {
        msg.term(ctx.terminateReason);
      });

      return undefined;
    }

    if (ctx.shouldRetry) {
      if (capture?.isFinalDelivery(msg)) {
        return capture.capture(
          msg,
          data,
          new Error('Retry requested on the final delivery attempt'),
        );
      }

      settleQuietly(logger, `Failed to nak ${msg.subject}:`, () => {
        msg.nak(ctx.retryDelay);
      });

      return undefined;
    }

    settleQuietly(logger, `Failed to ack ${msg.subject}:`, () => {
      msg.ack();
    });

    return undefined;
  };

  const settleFailure = async (msg: JsMsg, data: unknown, err: unknown): Promise<void> => {
    if (capture?.isFinalDelivery(msg)) {
      await capture.capture(msg, data, err);

      return;
    }

    settleQuietly(logger, `Failed to nak ${msg.subject}:`, () => {
      msg.nak();
    });
  };

  return { settleSuccess, settleFailure };
};
