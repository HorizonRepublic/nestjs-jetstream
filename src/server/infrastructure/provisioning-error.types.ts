/** Why the server refused to create or update a stream or consumer. */
export enum ProvisioningErrorReason {
  /** The reservation exceeds the server's `max_file_store` or the account's `max_storage`. */
  StorageExceeded = 'storage-exceeded',
  /** Fewer healthy peers than `num_replicas`, or none with storage headroom. */
  NoSuitablePeers = 'no-suitable-peers',
  /** Any other rejection; `errCode` holds the NATS code. */
  ServerRejected = 'server-rejected',
}
