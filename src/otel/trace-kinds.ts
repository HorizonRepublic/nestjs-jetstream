/**
 * Enumeration of OpenTelemetry trace kinds this library can emit.
 *
 * Each identifier is toggleable via `otel.traces`. Functional kinds (publish,
 * consume, RPC client round-trip, dead letter) are enabled by default;
 * infrastructure kinds (connection lifecycle, self-healing, provisioning,
 * migration, shutdown) are opt-in.
 *
 * @example
 *   JetstreamModule.forRoot({
 *     otel: {
 *       traces: [JetstreamTrace.Publish, JetstreamTrace.Consume, JetstreamTrace.ConnectionLifecycle],
 *     },
 *   })
 */
export enum JetstreamTrace {
  /** `PRODUCER` span around each `emit()` / `send()` publish operation. Default: ON. */
  Publish = 'publish',

  /**
   * `CONSUMER` span around each message delivery to a handler. Retries
   * produce separate spans with `messaging.nats.message.delivery_count > 1`.
   * Default: ON.
   */
  Consume = 'consume',

  /**
   * `CLIENT` span covering a full RPC round-trip on the caller side
   * (`client.send()` → reply received). Wraps the inner publish.
   * Default: ON.
   */
  RpcClientSend = 'rpc.client.send',

  /**
   * `INTERNAL` span emitted when a message exhausts `maxDeliver` and is
   * dead-lettered. Captures the duration of the `onDeadLetter` callback.
   * Default: ON.
   */
  DeadLetter = 'dead_letter',

  /**
   * `INTERNAL` span spanning one NATS connection session. Emits events on
   * connect, reconnect, disconnect. Default: OFF.
   */
  ConnectionLifecycle = 'connection.lifecycle',

  /**
   * `INTERNAL` span per consumer recovery attempt following a transient
   * failure (deleted consumer, missed heartbeat). Default: OFF.
   */
  SelfHealing = 'self_healing',

  /** `INTERNAL` span per stream or consumer provisioning / update at startup. Default: OFF. */
  Provisioning = 'provisioning',

  /** `INTERNAL` span covering a destructive migration flow. Default: OFF. */
  Migration = 'migration',

  /** `INTERNAL` span covering the graceful shutdown sequence. Default: OFF. */
  Shutdown = 'shutdown',
}

/**
 * The set of trace kinds enabled when `otel.traces` is not configured
 * (or set to `'default'`). Covers message-flow operations; infrastructure
 * spans are opt-in.
 */
export const DEFAULT_TRACES: readonly JetstreamTrace[] = [
  JetstreamTrace.Publish,
  JetstreamTrace.Consume,
  JetstreamTrace.RpcClientSend,
  JetstreamTrace.DeadLetter,
];
