import type { ConsumerConfig } from '@nats-io/jetstream';

import { ManagementMode, StreamKind } from '../../interfaces';
import type {
  AckExtensionConfig,
  EntityManagement,
  JetstreamModuleOptions,
  StreamConfigOverrides,
} from '../../interfaces';
import { isJetStreamRpcMode } from '../../jetstream.constants';

/** Entity slot within a kind. */
export type ManagedEntity = 'stream' | 'consumer';

/** A StreamKind or the DLQ pseudo-kind. */
export type ManagedKind = StreamKind | 'dlq';

/** Fields shared by every per-kind options block (events, rpc, broadcast, ordered). */
export interface KindOptionsBlock {
  stream?: StreamConfigOverrides;
  consumer?: Partial<ConsumerConfig>;
  ackExtension?: AckExtensionConfig;
  management?: EntityManagement;
  subjectPrefix?: string;
}

/** Single source of truth for navigating from a StreamKind to its options block. */
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

const entityManagementFor = (
  options: JetstreamModuleOptions,
  kind: ManagedKind,
): EntityManagement | undefined => {
  if (kind === 'dlq') return options.dlq?.management;

  return kindOptionsBlock(options, kind)?.management;
};

export const resolveManagementMode = (
  options: JetstreamModuleOptions,
  kind: ManagedKind,
  entity: ManagedEntity,
): ManagementMode =>
  entityManagementFor(options, kind)?.[entity] ??
  options.provisioning?.management ??
  ManagementMode.Auto;
