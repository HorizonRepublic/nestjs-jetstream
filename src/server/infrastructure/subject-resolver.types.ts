import type { StreamKind } from '../../interfaces';

/** Raw custom subject prefixes per stream kind, as a user wrote them. */
export type KindSubjectPrefixes = Partial<Record<StreamKind, string>>;
