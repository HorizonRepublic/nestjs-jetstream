import type { ConsumerInfo } from '@nats-io/jetstream';

import type { StreamKind } from '../../interfaces';

/**
 * Callback to recreate a consumer when it disappears.
 *
 * @param kind - Which durable consumer vanished.
 * @param lastKnown - The consumer as last read before it vanished, if any.
 */
export type ConsumerRecoveryFn = (
  kind: StreamKind,
  lastKnown?: ConsumerInfo | undefined,
) => Promise<ConsumerInfo>;
