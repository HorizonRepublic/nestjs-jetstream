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

  /**
   * Insufficient storage resources available — the requested reservation exceeds
   * the server `max_file_store` (or account `max_storage`) budget.
   * Sourced from nats-server v2.14.1 server/errors.json; confirmed at runtime by
   * the provisioning integration test.
   */
  InsufficientResources = 10047,

  /**
   * No suitable peers for placement — fewer healthy peers than `num_replicas`,
   * or no peer with enough reserved storage headroom (clustered deployments).
   * Sourced from nats-server v2.14.1 server/errors.json. NOT confirmed at runtime by
   * the integration test — triggering it requires a clustered NATS deployment (the test
   * runs single-node).
   */
  NoSuitablePeers = 10005,
}
