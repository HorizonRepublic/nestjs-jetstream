/**
 * NATS JetStream API error codes used by the transport.
 *
 * Ref: https://github.com/nats-io/nats-server (server error definitions)
 * Codes verified across NATS 2.12.6–2.14.1 via integration tests (original codes: 2026-04-02).
 */
export enum NatsErrorCode {
  /** Consumer does not exist on the specified stream. */
  ConsumerNotFound = 10014,

  /** Consumer name already in use with different configuration (race condition on create). */
  ConsumerAlreadyExists = 10148,

  /** Stream does not exist. */
  StreamNotFound = 10059,

  /** Insufficient storage resources — reservation exceeds server `max_file_store`. */
  InsufficientResources = 10047,

  /**
   * No suitable peers for placement (fewer healthy peers than `num_replicas`,
   * or no peer has storage headroom). Confirmed at runtime by the cluster integration test.
   */
  NoSuitablePeers = 10005,
}
