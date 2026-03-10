/** Identifies a JetStream stream/consumer kind. */
export type StreamKind = 'ev' | 'cmd' | 'broadcast';

/** Subset of StreamKind used for direct subject building (excludes broadcast). */
export type SubjectKind = Exclude<StreamKind, 'broadcast'>;
