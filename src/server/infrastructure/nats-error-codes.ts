/**
 * NATS JetStream API error codes used by the transport.
 *
 * Ref: https://github.com/nats-io/nats-server (server error definitions)
 * Verified on NATS 2.12.6 via integration tests (2026-04-02).
 */
export enum NatsErrorCode {
  /** Consumer does not exist on the specified stream. */
  ConsumerNotFound = 10014,

  /** Consumer name already in use with different configuration (race condition on create). */
  ConsumerAlreadyExists = 10148,

  /** Stream does not exist. */
  StreamNotFound = 10059,
}
