import { StreamKind } from '../../interfaces';
import type { JetstreamModuleOptions } from '../../interfaces';
import { consumerName, dlqStreamName, streamName } from '../../jetstream.constants';
import { dlqStreamOverrides } from './dlq-options';
import { kindOptionsBlock } from './management';
import { SubjectResolver } from './subject-resolver';
import type { KindSubjectPrefixes } from './subject-resolver.types';

interface KindNames {
  stream: string;
  consumer: string;
}

/** Single source of truth for all stream, consumer, and subject names. */
export class NameResolver {
  public readonly subjects: SubjectResolver;
  private readonly kinds: Map<StreamKind, KindNames>;
  private readonly dlq: string;

  public constructor(private readonly options: JetstreamModuleOptions) {
    this.dlq = dlqStreamOverrides(options).name ?? dlqStreamName(options.name);
    this.subjects = SubjectResolver.forService(options.name, this.customPrefixes());
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
    return this.subjects.subject(kind, pattern);
  }

  public filterSubject(kind: StreamKind): string {
    return this.subjects.filterSubject(kind);
  }

  public schedulePrefix(kind: StreamKind): string {
    return this.subjects.schedulePrefix(kind);
  }

  public hasCustomPrefix(kind: StreamKind): boolean {
    return this.subjects.hasCustomPrefix(kind);
  }

  private get(kind: StreamKind): KindNames {
    const entry = this.kinds.get(kind);

    if (!entry) throw new Error(`Unknown StreamKind: ${String(kind)}`);

    return entry;
  }

  private customPrefixes(): KindSubjectPrefixes {
    const prefixes: KindSubjectPrefixes = {};

    for (const kind of Object.values(StreamKind)) {
      const custom = kindOptionsBlock(this.options, kind)?.subjectPrefix;

      if (custom !== undefined) prefixes[kind] = custom;
    }

    return prefixes;
  }

  private buildKindMap(): Map<StreamKind, KindNames> {
    const map = new Map<StreamKind, KindNames>();
    const { name } = this.options;

    for (const kind of Object.values(StreamKind)) {
      const block = kindOptionsBlock(this.options, kind);

      map.set(kind, {
        stream: block?.stream?.name ?? streamName(name, kind),
        consumer: block?.consumer?.durable_name ?? consumerName(name, kind),
      });
    }

    return map;
  }
}
