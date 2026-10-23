import { StreamKind } from '../../interfaces';
import {
  BROADCAST_SUBJECT_PREFIX,
  internalName,
  SCHEDULE_HOLDER_SEGMENT,
  SCHEDULE_SEGMENT,
  subjectPrefix,
} from '../../jetstream.constants';
import type { KindSubjectPrefixes } from './subject-resolver.types';

interface KindSubjects {
  prefix: string;
  schedulePrefix: string;
  custom: boolean;
}

const normalizePrefix = (raw: string): string => {
  let end = raw.length;

  while (end > 0 && raw[end - 1] === '.') end -= 1;

  const trimmed = raw.slice(0, end);
  const tokens = trimmed.split('.');

  if (trimmed.length === 0 || tokens.some((t) => t.length === 0 || t === '>')) {
    throw new Error(
      `Invalid subjectPrefix "${raw}": expected non-empty dot-separated tokens without ">".`,
    );
  }

  return `${trimmed}.`;
};

/** One-shot holders live under `_sch.`; the schedule stream keeps its recurring holders under `_cron.`. */
const holderSegment = (kind: StreamKind): string =>
  kind === StreamKind.Schedule ? SCHEDULE_HOLDER_SEGMENT : SCHEDULE_SEGMENT;

const conventionSubjects = (name: string, kind: StreamKind): KindSubjects => {
  if (kind === StreamKind.Broadcast) {
    return {
      prefix: BROADCAST_SUBJECT_PREFIX,
      schedulePrefix: `${BROADCAST_SUBJECT_PREFIX}${SCHEDULE_SEGMENT}`,
      custom: false,
    };
  }

  return {
    prefix: subjectPrefix(name, kind),
    schedulePrefix: `${internalName(name)}.${holderSegment(kind)}`,
    custom: false,
  };
};

const customSubjects = (raw: string, kind: StreamKind): KindSubjects => {
  const prefix = normalizePrefix(raw);

  return { prefix, schedulePrefix: `${prefix}${holderSegment(kind)}`, custom: true };
};

/** Subject prefixes of one service, per stream kind, and the subjects built from them. */
export class SubjectResolver {
  private constructor(private readonly kinds: ReadonlyMap<StreamKind, KindSubjects>) {}

  /**
   * Resolve every kind of a service, honouring the custom prefixes it declares.
   *
   * @throws Error when a custom prefix is not a valid subject prefix.
   */
  public static forService(name: string, prefixes: KindSubjectPrefixes): SubjectResolver {
    const kinds = new Map<StreamKind, KindSubjects>();

    for (const kind of Object.values(StreamKind)) {
      const custom = prefixes[kind];

      kinds.set(
        kind,
        custom === undefined ? conventionSubjects(name, kind) : customSubjects(custom, kind),
      );
    }

    return new SubjectResolver(kinds);
  }

  /**
   * Resolve the subjects of another service as seen by a caller.
   *
   * Broadcast is one stream shared by every service, so it follows the
   * caller's own prefix rather than the target's.
   */
  public static forTarget(
    name: string,
    prefixes: KindSubjectPrefixes,
    caller: SubjectResolver,
  ): SubjectResolver {
    const kinds = new Map(SubjectResolver.forService(name, prefixes).kinds);

    kinds.set(StreamKind.Broadcast, caller.get(StreamKind.Broadcast));

    return new SubjectResolver(kinds);
  }

  public subject(kind: StreamKind, pattern: string): string {
    return `${this.get(kind).prefix}${pattern}`;
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

  /**
   * Map a resolved event subject back to its schedule-holder base subject
   * (the `_sch` namespace twin, without the per-message unique suffix).
   */
  public scheduleSubjectBase(eventSubject: string): string {
    for (const kind of [StreamKind.Broadcast, StreamKind.Event, StreamKind.Ordered]) {
      const { prefix, schedulePrefix } = this.get(kind);

      if (eventSubject.startsWith(prefix)) {
        return `${schedulePrefix}${eventSubject.slice(prefix.length)}`;
      }
    }

    throw new Error(`Unexpected event subject format: ${eventSubject}`);
  }

  private get(kind: StreamKind): KindSubjects {
    const entry = this.kinds.get(kind);

    if (!entry) throw new Error(`Unknown StreamKind: ${String(kind)}`);

    return entry;
  }
}
