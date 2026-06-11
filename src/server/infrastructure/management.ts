import { ManagementMode, StreamKind } from '../../interfaces';
import type { EntityManagement, JetstreamModuleOptions } from '../../interfaces';

/** Entity slot within a kind. */
export type ManagedEntity = 'stream' | 'consumer';

/** A StreamKind or the DLQ pseudo-kind. */
export type ManagedKind = StreamKind | 'dlq';

const entityManagementFor = (
  options: JetstreamModuleOptions,
  kind: ManagedKind,
): EntityManagement | undefined => {
  if (kind === 'dlq') return options.dlq?.management;

  switch (kind) {
    case StreamKind.Event:
      return options.events?.management;
    case StreamKind.Broadcast:
      return options.broadcast?.management;
    case StreamKind.Ordered:
      return options.ordered?.management;
    case StreamKind.Command:
      return options.rpc?.mode === 'jetstream' ? options.rpc.management : undefined;
    /* v8 ignore next 5 -- exhaustive switch guard, unreachable */
    default: {
      const _exhaustive: never = kind;

      throw new Error(`Unexpected kind: ${_exhaustive}`);
    }
  }
};

export const resolveManagementMode = (
  options: JetstreamModuleOptions,
  kind: ManagedKind,
  entity: ManagedEntity,
): ManagementMode =>
  entityManagementFor(options, kind)?.[entity] ??
  options.provisioning?.management ??
  ManagementMode.Auto;
