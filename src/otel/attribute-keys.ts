/**
 * Span attribute keys the library emits. One file, one source of truth —
 * so a rename in the OTel semconv (or in our own `jetstream.*` namespace)
 * is a single-file change, not a project-wide grep.
 *
 * Grouped by origin:
 *
 * - OTel messaging semantic conventions — stable / unstable keys we emit
 *   against the spec. Bumping the OTel major or swapping for the upstream
 *   `@opentelemetry/semantic-conventions` package only touches this file.
 * - OTel generic attributes (`server.*`) — same idea.
 * - Library-custom `jetstream.*` namespace — kept separate so external
 *   consumers can tell at a glance which keys are ours vs. OTel-mandated.
 * - Span-name prefixes — the verb that precedes the subject / resource in
 *   `span.name` (per OTel messaging convention `{operation} {destination}`).
 *
 * Every identifier is a literal `as const` so downstream `Attributes`
 * objects remain structurally typed.
 */

// ---- OTel messaging + generic attribute keys ---------------------------------

export const ATTR_MESSAGING_SYSTEM = 'messaging.system' as const;

export const ATTR_MESSAGING_DESTINATION_NAME = 'messaging.destination.name' as const;

export const ATTR_MESSAGING_DESTINATION_TEMPLATE = 'messaging.destination.template' as const;

export const ATTR_MESSAGING_CLIENT_ID = 'messaging.client.id' as const;

export const ATTR_MESSAGING_OPERATION_NAME = 'messaging.operation.name' as const;

export const ATTR_MESSAGING_OPERATION_TYPE = 'messaging.operation.type' as const;

export const ATTR_MESSAGING_MESSAGE_BODY_SIZE = 'messaging.message.body.size' as const;

export const ATTR_MESSAGING_MESSAGE_ID = 'messaging.message.id' as const;

export const ATTR_MESSAGING_MESSAGE_CONVERSATION_ID = 'messaging.message.conversation_id' as const;

export const ATTR_MESSAGING_CONSUMER_GROUP_NAME = 'messaging.consumer.group.name' as const;

export const ATTR_MESSAGING_HEADER_PREFIX = 'messaging.header.' as const;

export const ATTR_MESSAGING_NATS_STREAM_NAME = 'messaging.nats.stream.name' as const;

export const ATTR_MESSAGING_NATS_STREAM_SEQUENCE =
  'messaging.nats.message.stream_sequence' as const;

export const ATTR_MESSAGING_NATS_CONSUMER_SEQUENCE =
  'messaging.nats.message.consumer_sequence' as const;

export const ATTR_MESSAGING_NATS_DELIVERY_COUNT = 'messaging.nats.message.delivery_count' as const;

export const ATTR_MESSAGING_NATS_BODY = 'messaging.nats.message.body' as const;

export const ATTR_MESSAGING_NATS_BODY_TRUNCATED = 'messaging.nats.message.body.truncated' as const;

export const ATTR_SERVER_ADDRESS = 'server.address' as const;

export const ATTR_SERVER_PORT = 'server.port' as const;

// ---- Library-custom `jetstream.*` keys ---------------------------------------

export const ATTR_JETSTREAM_SERVICE_NAME = 'jetstream.service.name' as const;

export const ATTR_JETSTREAM_KIND = 'jetstream.kind' as const;

export const ATTR_JETSTREAM_RPC_REPLY_HAS_ERROR = 'jetstream.rpc.reply.has_error' as const;

export const ATTR_JETSTREAM_RPC_REPLY_ERROR_CODE = 'jetstream.rpc.reply.error.code' as const;

export const ATTR_JETSTREAM_PROVISIONING_ENTITY = 'jetstream.provisioning.entity' as const;

export const ATTR_JETSTREAM_PROVISIONING_ACTION = 'jetstream.provisioning.action' as const;

export const ATTR_JETSTREAM_PROVISIONING_NAME = 'jetstream.provisioning.name' as const;

export const ATTR_JETSTREAM_SELF_HEALING_REASON = 'jetstream.self_healing.reason' as const;

export const ATTR_JETSTREAM_MIGRATION_REASON = 'jetstream.migration.reason' as const;

export const ATTR_JETSTREAM_DEAD_LETTER_REASON = 'jetstream.dead_letter.reason' as const;

export const ATTR_JETSTREAM_SCHEDULE_TARGET = 'jetstream.schedule.target' as const;

export const ATTR_NATS_CONNECTION_SERVER = 'nats.connection.server' as const;

// ---- NATS server-level header names (read by the transport) -----------------

/** Canonical MIME form of the NATS dedup header (`Nats-Msg-Id`). */
export const NATS_MSG_ID_HEADER = 'Nats-Msg-Id' as const;

// ---- Hook identifier tokens -------------------------------------------------
// Passed to `safelyInvokeHook(hookName, ...)` so a failing hook's debug log
// identifies which hook misbehaved without hard-coding strings at call sites.

export const HOOK_PUBLISH = 'publishHook' as const;

export const HOOK_CONSUME = 'consumeHook' as const;

export const HOOK_RESPONSE = 'responseHook' as const;

// ---- Span / event name builders ---------------------------------------------

/** Operation verbs that precede the subject / resource in `span.name`. */
export const SPAN_NAME_PUBLISH = 'publish' as const;

export const SPAN_NAME_PROCESS = 'process' as const;

export const SPAN_NAME_SEND = 'send' as const;

export const SPAN_NAME_DEAD_LETTER = 'dead_letter' as const;

/** Infrastructure span names — resource identity lives in attributes, not the name. */
export const SPAN_NAME_NATS_CONNECTION = 'nats.connection' as const;

export const SPAN_NAME_JETSTREAM_SHUTDOWN = 'jetstream.shutdown' as const;

export const SPAN_NAME_JETSTREAM_SELF_HEALING = 'jetstream.self_healing' as const;

export const SPAN_NAME_JETSTREAM_MIGRATION = 'jetstream.migration' as const;

export const SPAN_NAME_JETSTREAM_PROVISIONING_PREFIX = 'jetstream.provisioning.' as const;

/** Span-event labels raised during a span's lifetime. */
export const EVENT_CONNECTION_DISCONNECTED = 'connection.disconnected' as const;

export const EVENT_CONNECTION_RECONNECTED = 'connection.reconnected' as const;

/**
 * Build a `messaging.header.<lowercase-name>` attribute key.
 * Wrapper so call sites don't duplicate the prefix and we keep the
 * convention in one place.
 */
export const messagingHeaderAttr = (headerName: string): string =>
  `${ATTR_MESSAGING_HEADER_PREFIX}${headerName.toLowerCase()}`;
