import { StreamKind } from '../../interfaces';
import type {
  JetstreamModuleOptions,
  OrderedEventOverrides,
  StreamConfigOverrides,
} from '../../interfaces';
import type { ConsumerConfig } from '@nats-io/jetstream';
import {
  buildBroadcastSubject,
  buildSubject,
  consumerName,
  dlqStreamName,
  internalName,
  isJetStreamRpcMode,
  streamName,
} from '../../jetstream.constants';

interface KindOptionBlock {
  stream?: StreamConfigOverrides;
  consumer?: Partial<ConsumerConfig>;
  subjectPrefix?: string;
}

interface KindNames {
  stream: string;
  consumer: string;
  prefix: string;
  schedulePrefix: string;
  custom: boolean;
}

/** Single source of truth for all stream, consumer, and subject names. */
export class NameResolver {
  private readonly kinds: Map<StreamKind, KindNames>;
  private readonly dlq: string;

  public constructor(private readonly options: JetstreamModuleOptions) {
    this.dlq = options.dlq?.stream?.name ?? dlqStreamName(options.name);
    this.kinds = this.buildKindMap();
  }

  public streamName(kind: StreamKind): string {
    return this.get(kind).stream;
  }

  public consumerName(kind: StreamKind): string {
    return this.get(kind).consumer;
  }

  public dlqStreamName(): string {
    return this.dlq;
  }

  public subject(kind: StreamKind, pattern: string): string {
    const { prefix, custom } = this.get(kind);

    if (custom) return `${prefix}${pattern}`;

    if (kind === StreamKind.Broadcast) return buildBroadcastSubject(pattern);

    return buildSubject(this.options.name, kind, pattern);
  }

  public filterSubject(kind: StreamKind): string {
    return `${this.get(kind).prefix}>`;
  }

  public schedulePrefix(kind: StreamKind): string {
    return this.get(kind).schedulePrefix;
  }

  public hasCustomPrefix(kind: StreamKind): boolean {
    return this.get(kind).custom;
  }

  private get(kind: StreamKind): KindNames {
    const entry = this.kinds.get(kind);

    if (!entry) throw new Error(`Unknown StreamKind: ${String(kind)}`);

    return entry;
  }

  private buildKindMap(): Map<StreamKind, KindNames> {
    const map = new Map<StreamKind, KindNames>();
    const { name } = this.options;

    for (const kind of Object.values(StreamKind)) {
      const block = this.kindBlock(kind);
      const customPrefix = block?.subjectPrefix;
      const custom = customPrefix !== undefined;
      const prefix = custom
        ? this.normalizePrefix(customPrefix)
        : this.conventionPrefix(name, kind);

      map.set(kind, {
        stream: block?.stream?.name ?? streamName(name, kind),
        consumer: block?.consumer?.durable_name ?? consumerName(name, kind),
        prefix,
        schedulePrefix: custom ? `${prefix}_sch.` : this.conventionSchedulePrefix(name, kind),
        custom,
      });
    }

    return map;
  }

  private kindBlock(kind: StreamKind): KindOptionBlock | undefined {
    switch (kind) {
      case StreamKind.Event:
        return this.options.events;
      case StreamKind.Broadcast:
        return this.options.broadcast;
      case StreamKind.Ordered:
        return this.orderedBlock();
      case StreamKind.Command:
        return this.commandBlock();
      default: {
        /* v8 ignore next 5 -- exhaustive switch guard, unreachable */
        const _exhaustive: never = kind;

        throw new Error(`Unhandled StreamKind: ${String(_exhaustive)}`);
      }
    }
  }

  private orderedBlock(): OrderedEventOverrides | undefined {
    return this.options.ordered;
  }

  private commandBlock(): KindOptionBlock | undefined {
    const { rpc } = this.options;

    if (!isJetStreamRpcMode(rpc)) return undefined;

    return rpc;
  }

  private normalizePrefix(raw: string): string {
    return `${raw.replace(/\.$/, '')}.`;
  }

  private conventionPrefix(name: string, kind: StreamKind): string {
    if (kind === StreamKind.Broadcast) return 'broadcast.';

    return `${internalName(name)}.${kind}.`;
  }

  private conventionSchedulePrefix(name: string, kind: StreamKind): string {
    if (kind === StreamKind.Broadcast) return 'broadcast._sch.';

    return `${internalName(name)}._sch.`;
  }
}
