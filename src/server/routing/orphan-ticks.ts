import type { Logger } from '@nestjs/common';

import type { JsMsg } from '@nats-io/jetstream';

import type { OrphanTickPolicy } from './routing.types';

/** The server names the holder that fired a tick in this header. */
const SCHEDULER_HEADER = 'Nats-Scheduler';

/** Hand an unhandled tick back, or cancel its schedule once every delivery is spent. */
export const settleOrphanTick = async (
  policy: OrphanTickPolicy,
  msg: JsMsg,
  logger: Logger,
): Promise<void> => {
  if (msg.info.deliveryCount < policy.maxDeliver()) {
    logger.debug(`No handler for schedule tick ${msg.subject}; handing it to another replica`);
    msg.nak(policy.redeliverDelayMs);

    return;
  }

  const holder = msg.headers?.get(SCHEDULER_HEADER);

  if (!holder) {
    logger.error(`No handler for ${msg.subject}, and the tick names no schedule to cancel`);
    msg.term(`No handler for schedule tick: ${msg.subject}`);

    return;
  }

  try {
    await policy.cancel(holder);
    logger.warn(`Schedule ${holder} has no handler in this service; cancelled it.`);
  } catch (err) {
    logger.error(`Failed to cancel orphaned schedule ${holder}:`, err);
  }

  msg.term(`No handler for schedule tick: ${msg.subject}`);
};
