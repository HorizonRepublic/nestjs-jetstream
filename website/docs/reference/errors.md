---
sidebar_position: 5
sidebar_label: "Errors"
title: "Errors: Typed Errors Thrown by the Transport"
description: "Every error class the NestJS JetStream transport throws or rejects with, the reason values each one carries, and how to catch them by area or by exact cause."
schema:
  type: Article
  headline: "Errors: Typed Errors Thrown by the Transport"
  description: "Typed error classes, their reason values, and how to catch them."
  datePublished: "2026-10-27"
  dateModified: "2026-10-29"
---

# Errors

> **Use when:** you catch an error from the transport and need to tell causes apart.
> **You get:** every error class, the `reason` values it carries, and what to do about each.

Each class is named after the area it comes from, `Jetstream<Area>Error`, and carries a `reason` that names the exact cause. Catch a whole area with `instanceof`, or one cause with `reason`:

```typescript
import { JetstreamPublishError, PublishErrorReason, isJetstreamError } from '@horizon-republic/nestjs-jetstream';

try {
  await firstValueFrom(client.emit('order.placed', order));
} catch (err) {
  if (err instanceof JetstreamPublishError && err.reason === PublishErrorReason.StreamFull) {
    // back off, alert, or spill to another store
  }

  if (isJetstreamError(err)) {
    logger.error(`${err.name} (${err.reason}): ${err.message}`);
  }
}
```

`isJetstreamError()` recognises every typed error, `JetstreamPublishError` included. Prefer it over `instanceof` when your process may load the package twice, as the CommonJS and ES module builds of one dependency tree can: `instanceof` fails across the two copies, the guard does not.

All classes except `JetstreamPublishError` extend the abstract `JetstreamBaseError`. Match on `reason` rather than on message text.

## At a glance

| Class                        | Thrown when                                                      | Reason enum               |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------- |
| `JetstreamConfigError`       | Module options or handler declarations are invalid, at startup   | `ConfigErrorReason`       |
| `JetstreamConnectionError`   | The NATS connection is missing or refused                        | `ConnectionErrorReason`   |
| `JetstreamProvisioningError` | The server refuses to create or update a stream or consumer      | `ProvisioningErrorReason` |
| `JetstreamBindingError`      | Externally managed streams or consumers do not fit your handlers | `BindingErrorReason`      |
| `JetstreamMigrationError`    | A destructive stream migration is refused or does not finish     | `MigrationErrorReason`    |
| `JetstreamPublishError`      | The target stream is full and rejects an `emit()` or `send()`    | `PublishErrorReason`      |
| `JetstreamRecordError`       | A `JetstreamRecordBuilder` value or delivery option is invalid   | `RecordErrorReason`       |
| `JetstreamRpcError`          | An RPC call fails, or `RpcContext` settlement is misused         | `RpcErrorReason`          |
| `JetstreamDeliveryError`     | A delivered event cannot be handled; passed to `onDeadLetter`    | `DeliveryErrorReason`     |
| `JetstreamScheduleError`     | A schedule is refused by the client or the server                | `ScheduleErrorReason`     |
| `JetstreamCapabilityError`   | A feature needs a newer NATS server than the one connected       | `CapabilityErrorReason`   |

## `JetstreamPublishError`

| Reason        | When                                                                                                  | What to do                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `stream-full` | The stream reached `max_msgs`, `max_bytes` or `max_msgs_per_subject` and its policy is `discard: new` | Check that consumers are running and keeping up, then raise the limits in the stream override. |

`JetstreamPublishError` extends nats.js `JetStreamApiError`, so code written against the raw nats.js error keeps working: `instanceof JetStreamApiError` holds, and `code`, `status` and `message` are the server's. The original error is `cause`. Other publish failures, such as a timeout or no responders, reach you as the nats.js errors they always were.

## `JetstreamRpcError`

| Reason                | When                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `timeout`             | No reply arrived within the RPC timeout (JetStream RPC mode)                         |
| `connection-lost`     | The connection dropped while the call was pending (JetStream RPC mode)               |
| `client-closed`       | The client closed while the call was pending (JetStream RPC mode)                    |
| `duplicate-publish`   | The command's message ID was already used inside the stream's dedup window           |
| `decode-failed`       | The reply could not be decoded and the codec threw a non-`Error` value               |
| `inbox-not-ready`     | The reply inbox was not subscribed when the command went out                         |
| `internal-transport`  | The publish failed unexpectedly; the cause is in the transport's error log           |
| `settlement-conflict` | A handler called both `retry()` and `terminate()` on its `RpcContext`                |
| `jetstream-only`      | `retry()` or `terminate()` was called for a message that did not come from JetStream |

In Core RPC mode a timeout is the nats.js `TimeoutError`, as before.

## `JetstreamDeliveryError`

Passed as `error` to `onDeadLetter` and to the `DeadLetter` hook, and its message becomes the DLQ `x-dead-letter-reason` header.

| Reason                   | When                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `no-handler`             | No handler is registered for the event's subject                                         |
| `decode-failed`          | The codec could not decode the payload; the codec's error is `cause`                     |
| `retry-on-final-attempt` | The handler called `retry()` on the last delivery `max_deliver` allows                   |
| `deliveries-exhausted`   | The server stopped redelivering: the handler outlived `ack_wait`, or the process stopped |

An error your handler throws reaches `onDeadLetter` as is.

## `JetstreamRecordError`

| Reason                             | When                                                              |
| ---------------------------------- | ----------------------------------------------------------------- |
| `invalid-schedule-date`            | `scheduleAt()` got an invalid `Date`                              |
| `schedule-in-past`                 | `scheduleAt()` got a date that is not in the future               |
| `invalid-ttl`                      | `ttl()` got a value that is not a positive finite number          |
| `reserved-nats-header`             | `setHeader()` targeted a `Nats-*` header the server interprets    |
| `reserved-transport-header`        | `setHeader()` targeted a header the transport owns                |
| `schedule-unsupported-for-ordered` | A record with `scheduleAt()` was emitted to an `ordered:` pattern |

## `JetstreamConfigError`

Thrown during startup, so it stops the application before it serves traffic.

| Reason                        | When                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `servers-or-connections`      | Both or neither of `servers` and `connections` are set                                 |
| `no-connections`              | `connections` is empty                                                                 |
| `no-servers`                  | A connection declares no servers                                                       |
| `invalid-connection-name`     | A connection name is empty or has surrounding whitespace                               |
| `default-connection-required` | No connection is called `default` and `defaultConnection` is not set                   |
| `unknown-connection`          | A connection name in `defaultConnection`, handler extras or a lookup is not configured |
| `duplicate-cluster`           | Two consuming connections point at the same NATS cluster                               |
| `publisher-only-connection`   | A handler is bound to a `publisherOnly` connection                                     |
| `connections-not-started`     | `connectJetstreamMicroservices(app)` was not called before `startAllMicroservices()`   |
| `stream-ownership-conflict`   | A stream is already owned by another connection of the same service                    |
| `dlq-unavailable`             | `JetstreamDlq` was called on a connection whose DLQ stream is off or was never created |
| `removed-options`             | Options removed in v3 are still passed                                                 |
| `self-target-prefix`          | `forFeature()` targets the service itself and passes a `subjectPrefix`                 |
| `invalid-subject-prefix`      | A `subjectPrefix` is empty, malformed or contains `>`                                  |
| `duplicate-handler`           | Two handlers declare the same pattern                                                  |
| `conflicting-handler-kinds`   | A handler is declared broadcast and ordered, or scheduled and broadcast or ordered     |
| `schedule-on-message-pattern` | A schedule is declared on `@MessagePattern`                                            |
| `invalid-ack-extension`       | `ackExtension.interval` or `ackExtension.maxDuration` is not a positive number         |
| `metrics-registry-missing`    | Metrics are enabled but no Prometheus registry was resolved                            |
| `prometheus-client-missing`   | Metrics are enabled but neither `@prometheus-io/client` nor `prom-client` is installed |
| `ambiguous-prometheus-client` | Both Prometheus packages are installed and `metrics.register` is not set               |
| `foreign-registry`            | `metrics.register` belongs to neither installed Prometheus package                     |

## `JetstreamConnectionError`

| Reason                    | When                                                             |
| ------------------------- | ---------------------------------------------------------------- |
| `not-connected`           | `unwrap()` or a JetStream client was requested before connecting |
| `refused`                 | The servers refused the connection; the NATS error is `cause`    |
| `closed-while-connecting` | The transport closed while its connection was still starting     |

## `JetstreamProvisioningError`

| Reason              | When                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `storage-exceeded`  | The reservation exceeds the server's `max_file_store` or account storage |
| `no-suitable-peers` | Fewer healthy peers than `num_replicas`, or none with storage headroom   |
| `server-rejected`   | Any other refusal; `errCode` holds the NATS code                         |

Each error also carries `entity`, `target`, `kind`, `errCode`, `errDescription` and a `remediation` hint.

## `JetstreamBindingError`

Under `provisioning: { management: Manual }` the transport checks the streams and consumers you manage against your handlers.

| Reason                        | When                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `consumer-filter-mismatch`    | The consumer's filter does not cover every registered handler subject         |
| `dlq-subject-mismatch`        | The DLQ stream's subjects do not include the stream name                      |
| `schedule-subject-mismatch`   | Scheduling is enabled but the stream's subjects miss the schedule prefix      |
| `consumer-swallows-schedules` | The consumer's filter also matches pending schedule holders                   |
| `external-consumer-absent`    | The externally managed consumer is gone; the transport waits for it to return |

## `JetstreamMigrationError`

| Reason                      | When                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `transport-config-conflict` | The change touches settings the transport controls, such as retention                               |
| `schedule-stream`           | The stream is a schedule stream, which NATS cannot source into                                      |
| `shared-stream`             | The stream is the broadcast stream other services share                                             |
| `sourcing-timeout`          | Sourcing made no progress for 30 seconds; after the delete, the backup is kept and restored later   |
| `peer-timeout`              | No longer raised since v3.1: an instance waits for a live migration and takes over an abandoned one |
| `insufficient-capacity`     | The new `max_msgs` or `max_bytes` cannot hold what the stream already has; nothing was deleted      |
| `lock-lost`                 | Another instance took the migration over; this one stopped before a destructive step                |
| `in-progress`               | Consumer recovery waits for a running migration to finish                                           |

See [stream migration](/docs/guides/stream-migration).

## `JetstreamScheduleError` and `JetstreamCapabilityError`

`JetstreamScheduleError` reasons are listed in [recurring schedules](/docs/guides/recurring-schedules). Since 3.1 it also reports `leader-change`, `concurrent-writer` and `no-schedule-stream`, which used to be plain `Error`s.

`JetstreamCapabilityError` has a single reason, `server-too-old`, alongside its `capability`, `requiredLevel` and `actualLevel` fields.
