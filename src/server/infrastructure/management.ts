import type { ConsumerConfig } from '@nats-io/jetstream';

import { ManagementMode, StreamKind } from '../../interfaces';
import type {
  AckExtensionConfig,
  EntityManagement,
  JetstreamModuleOptions,
  StreamConfigOverrides,
} from '../../interfaces';
import { isJetStreamRpcMode } from '../../jetstream.constants';
import { dlqOptions } from './dlq-options';

/** Entity slot within a kind. */
export type ManagedEntity = 'stream' | 'consumer';

/** A StreamKind or the DLQ pseudo-kind. */
export type ManagedKind = StreamKind | 'dlq';

/**
 * Fields shared by every per-kind options block (events, rpc, broadcast, ordered).
 *
 * `management` widens to either shape: the kinds that own a durable consumer
 * carry {@link EntityManagement}, and the ones that do not carry a bare mode.
 */
export interface KindOptionsBlock {
  stream?: StreamConfigOverrides;
  consumer?: Partial<ConsumerConfig>;
  ackExtension?: AckExtensionConfig;
  management?: EntityManagement | ManagementMode;
  subjectPrefix?: string;
}

/** Single source of truth for resolving a StreamKind to its options block. */
export const kindOptionsBlock = (
  options: JetstreamModuleOptions,
  kind: StreamKind,
): KindOptionsBlock | undefined => {
  switch (kind) {
    case StreamKind.Event:
      return options.events;
    case StreamKind.Broadcast:
      return options.broadcast;
    case StreamKind.Ordered:
      return options.ordered;
    case StreamKind.Command:
      return isJetStreamRpcMode(options.rpc) ? options.rpc : undefined;
    /* v8 ignore next 5 -- exhaustive switch guard, unreachable */
    default: {
      const _exhaustive: never = kind;

      throw new Error(`Unhandled StreamKind: ${String(_exhaustive)}`);
    }
  }
};

const managementFor = (
  options: JetstreamModuleOptions,
  kind: ManagedKind,
): EntityManagement | ManagementMode | undefined => {
  if (kind === 'dlq') return dlqOptions(options)?.management;

  return kindOptionsBlock(options, kind)?.management;
};

/**
 * A kind without a durable consumer declares one mode for its stream, so a
 * bare mode answers for whichever entity is asked about.
 */
const slotOf = (
  declared: EntityManagement | ManagementMode | undefined,
  entity: ManagedEntity,
): ManagementMode | undefined => (typeof declared === 'string' ? declared : declared?.[entity]);

export const resolveManagementMode = (
  options: JetstreamModuleOptions,
  kind: ManagedKind,
  entity: ManagedEntity,
): ManagementMode =>
  slotOf(managementFor(options, kind), entity) ??
  options.provisioning?.management ??
  ManagementMode.Auto;
