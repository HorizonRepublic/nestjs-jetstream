/**
 * NATS JetStream API error codes used by the transport.
 *
 * Ref: https://github.com/nats-io/nats-server (server error definitions)
 * Codes verified across NATS 2.12.6-2.14.1 via integration tests (original codes: 2026-04-02).
 */
export enum NatsErrorCode {
  /** Consumer does not exist on the specified stream. */
  ConsumerNotFound = 10014,

  /** Consumer name already in use with different configuration (race condition on create). */
  ConsumerAlreadyExists = 10148,

  /** Stream does not exist. */
  StreamNotFound = 10059,

  /** Stream name already in use with a different configuration (race condition on create). */
  StreamAlreadyExists = 10058,

  /** Storage resources exceeded: reservation exceeds server `max_file_store`. */
  StorageResourcesExceeded = 10047,

  /**
   * No suitable peers for placement (fewer healthy peers than `num_replicas`,
   * or no peer has storage headroom). Confirmed at runtime by the cluster integration test.
   */
  NoSuitablePeers = 10005,

  /** The stream refused to store a message, e.g. a `discard: new` stream at its limits. */
  StreamStoreFailed = 10077,

  /** `expect.lastSubjectSequence` did not match: the subject changed since it was read. */
  StreamWrongLastSequence = 10071,

  /** The same mismatch, reported without the sequence. */
  StreamWrongLastSequenceConstant = 10164,

  /** The per-subject last sequence is momentarily unknown, for example after a leader change. */
  StreamExpectedLastSeqPerSubjectNotReady = 10163,

  /** The stream does not allow message schedules. */
  MessageSchedulesDisabled = 10188,

  /** The `Nats-Schedule` value is not a pattern this server accepts. */
  MessageSchedulesPatternInvalid = 10189,

  /** The schedule target is not a literal subject inside the same stream. */
  MessageSchedulesTargetInvalid = 10190,

  /** The schedule TTL is invalid, or the stream does not allow message TTLs. */
  MessageSchedulesTtlInvalid = 10191,

  /** The schedule time zone is unknown to the server, usually an image without tzdata. */
  MessageSchedulesTimeZoneInvalid = 10223,
}
