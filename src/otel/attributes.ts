import type { Attributes, Span } from '@opentelemetry/api';
import type { DeliveryInfo } from '@nats-io/jetstream';

import {
  ATTR_JETSTREAM_DEAD_LETTER_REASON,
  ATTR_JETSTREAM_KIND,
  ATTR_JETSTREAM_RPC_REPLY_ERROR_CODE,
  ATTR_JETSTREAM_RPC_REPLY_HAS_ERROR,
  ATTR_MESSAGING_CLIENT_ID,
  ATTR_MESSAGING_CONSUMER_GROUP_NAME,
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_DESTINATION_TEMPLATE,
  ATTR_MESSAGING_MESSAGE_BODY_SIZE,
  ATTR_MESSAGING_MESSAGE_CONVERSATION_ID,
  ATTR_MESSAGING_MESSAGE_ID,
  ATTR_MESSAGING_NATS_CONSUMER_SEQUENCE,
  ATTR_MESSAGING_NATS_DELIVERY_COUNT,
  ATTR_MESSAGING_NATS_STREAM_NAME,
  ATTR_MESSAGING_NATS_STREAM_SEQUENCE,
  ATTR_MESSAGING_OPERATION_NAME,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  NATS_MSG_ID_HEADER,
  SPAN_NAME_DEAD_LETTER,
  SPAN_NAME_PROCESS,
  SPAN_NAME_PUBLISH,
  SPAN_NAME_SEND,
} from './attribute-keys';
import type { ConsumeSourceMsg, JetstreamPublishContext, JetstreamConsumeContext } from './config';
import { PublishKind } from './config';

// `messaging.system` isn't in the OTel registry yet; "nats" is the
// community convention used by opentelemetry-js-contrib and third-party
// NATS integrations.
const MESSAGING_SYSTEM = 'nats';

/** Attributes common to every messaging span. */
export interface MessagingBaseContext {
  readonly subject: string;
  readonly pattern?: string;
  readonly serviceName: string;
  /** Omitted when the NATS URL couldn't be parsed — we'd rather not emit than invent. */
  readonly serverAddress?: string;
  /** Omitted when the user-supplied NATS URL had no explicit port. */
  readonly serverPort?: number;
}

const baseMessagingAttributes = (ctx: MessagingBaseContext): Attributes => {
  const attrs: Attributes = {
    [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM,
    [ATTR_MESSAGING_DESTINATION_NAME]: ctx.subject,
    [ATTR_MESSAGING_CLIENT_ID]: ctx.serviceName,
  };

  if (ctx.serverAddress) attrs[ATTR_SERVER_ADDRESS] = ctx.serverAddress;
  if (ctx.serverPort !== undefined) attrs[ATTR_SERVER_PORT] = ctx.serverPort;
  if (ctx.pattern && ctx.pattern !== ctx.subject) {
    attrs[ATTR_MESSAGING_DESTINATION_TEMPLATE] = ctx.pattern;
  }

  return attrs;
};

export interface PublishAttributeContext extends MessagingBaseContext {
  readonly kind: JetstreamPublishContext['kind'];
  readonly payloadBytes: number;
  readonly messageId?: string;
  readonly correlationId?: string;
}

const jetstreamKindForPublish = (kind: JetstreamPublishContext['kind']): string =>
  kind === PublishKind.RpcRequest ? 'rpc' : kind;

export const buildPublishAttributes = (ctx: PublishAttributeContext): Attributes => {
  const attrs: Attributes = {
    ...baseMessagingAttributes(ctx),
    [ATTR_MESSAGING_OPERATION_NAME]: SPAN_NAME_PUBLISH,
    [ATTR_MESSAGING_OPERATION_TYPE]: SPAN_NAME_SEND,
    [ATTR_MESSAGING_MESSAGE_BODY_SIZE]: ctx.payloadBytes,
    [ATTR_JETSTREAM_KIND]: jetstreamKindForPublish(ctx.kind),
  };

  if (ctx.messageId) attrs[ATTR_MESSAGING_MESSAGE_ID] = ctx.messageId;
  if (ctx.correlationId) attrs[ATTR_MESSAGING_MESSAGE_CONVERSATION_ID] = ctx.correlationId;

  return attrs;
};

export interface ConsumeAttributeContext extends MessagingBaseContext {
  readonly msg: ConsumeSourceMsg;
  /** JetStream delivery metadata. Absent for Core NATS RPC messages. */
  readonly info?: DeliveryInfo;
  readonly kind: JetstreamConsumeContext['kind'];
  readonly payloadBytes: number;
}

export const buildConsumeAttributes = (ctx: ConsumeAttributeContext): Attributes => {
  const { msg, info, kind, payloadBytes } = ctx;
  const attrs: Attributes = {
    ...baseMessagingAttributes(ctx),
    [ATTR_MESSAGING_OPERATION_NAME]: SPAN_NAME_PROCESS,
    [ATTR_MESSAGING_OPERATION_TYPE]: SPAN_NAME_PROCESS,
    [ATTR_MESSAGING_MESSAGE_BODY_SIZE]: payloadBytes,
    [ATTR_JETSTREAM_KIND]: kind,
  };

  if (info) {
    attrs[ATTR_MESSAGING_NATS_STREAM_NAME] = info.stream;
    attrs[ATTR_MESSAGING_CONSUMER_GROUP_NAME] = info.consumer;
    attrs[ATTR_MESSAGING_NATS_STREAM_SEQUENCE] = info.streamSequence;
    attrs[ATTR_MESSAGING_NATS_CONSUMER_SEQUENCE] = info.deliverySequence;
    attrs[ATTR_MESSAGING_NATS_DELIVERY_COUNT] = info.deliveryCount;
  }

  const messageId = msg.headers?.get(NATS_MSG_ID_HEADER);

  if (messageId) attrs[ATTR_MESSAGING_MESSAGE_ID] = messageId;

  return attrs;
};

export interface RpcClientAttributeContext extends MessagingBaseContext {
  readonly correlationId: string;
  readonly payloadBytes: number;
  readonly messageId?: string;
}

export const buildRpcClientAttributes = (ctx: RpcClientAttributeContext): Attributes => {
  const attrs: Attributes = {
    ...baseMessagingAttributes(ctx),
    [ATTR_MESSAGING_OPERATION_NAME]: SPAN_NAME_SEND,
    [ATTR_MESSAGING_OPERATION_TYPE]: SPAN_NAME_SEND,
    [ATTR_MESSAGING_MESSAGE_BODY_SIZE]: ctx.payloadBytes,
    [ATTR_MESSAGING_MESSAGE_CONVERSATION_ID]: ctx.correlationId,
    [ATTR_JETSTREAM_KIND]: 'rpc',
  };

  if (ctx.messageId) attrs[ATTR_MESSAGING_MESSAGE_ID] = ctx.messageId;

  return attrs;
};

export interface DeadLetterAttributeContext extends MessagingBaseContext {
  readonly finalDeliveryCount: number;
  readonly reason?: string;
}

export const buildDeadLetterAttributes = (ctx: DeadLetterAttributeContext): Attributes => {
  const attrs: Attributes = {
    ...baseMessagingAttributes(ctx),
    [ATTR_MESSAGING_OPERATION_NAME]: SPAN_NAME_DEAD_LETTER,
    [ATTR_MESSAGING_OPERATION_TYPE]: SPAN_NAME_PROCESS,
    [ATTR_MESSAGING_NATS_DELIVERY_COUNT]: ctx.finalDeliveryCount,
  };

  if (ctx.reason) attrs[ATTR_JETSTREAM_DEAD_LETTER_REASON] = ctx.reason;

  return attrs;
};

/**
 * Pull a structured code off an error that's been classified as expected.
 * Tries sources in order and falls through to the next when a source
 * yields nothing:
 *   1. `RpcException.getError()` payload → `codeFromPayload`
 *   2. `HttpException.getStatus()` → `HTTP_<status>`
 *   3. `err.code` / `err.errorCode` if they look like stable codes
 *
 * Returns `undefined` if nothing matches; `jetstream.rpc.reply.has_error`
 * is still set by the caller so the outcome remains visible in APM.
 */
const extractFromRpcException = (record: Record<string, unknown>): string | undefined => {
  const getError = record.getError;

  if (typeof getError !== 'function') return undefined;

  return codeFromPayload((getError as () => unknown).call(record));
};

const extractFromHttpException = (record: Record<string, unknown>): string | undefined => {
  const getStatus = record.getStatus;

  if (typeof getStatus !== 'function') return undefined;
  const status = (getStatus as () => number).call(record);

  return typeof status === 'number' && Number.isFinite(status) ? `HTTP_${status}` : undefined;
};

const extractFromOwnCode = (record: Record<string, unknown>): string | undefined => {
  const code = record.code ?? record.errorCode;

  return typeof code === 'string' && isStableErrorCode(code) ? code : undefined;
};

const extractExpectedErrorCode = (err: unknown): string | undefined => {
  if (err === null || typeof err !== 'object') return undefined;
  const record = err as Record<string, unknown>;

  if (hasAncestorNamed(err, 'RpcException')) {
    const fromPayload = extractFromRpcException(record);

    if (fromPayload !== undefined) return fromPayload;
  }

  if (hasAncestorNamed(err, 'HttpException')) {
    const fromStatus = extractFromHttpException(record);

    if (fromStatus !== undefined) return fromStatus;
  }

  return extractFromOwnCode(record);
};

const hasAncestorNamed = (err: unknown, name: string): boolean => {
  let proto: object | null = Object.getPrototypeOf(err) as object | null;

  while (proto) {
    const ctorName = (proto as { constructor?: { name?: string } }).constructor?.name;

    if (ctorName === name) return true;
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  return false;
};

/**
 * Match shape only for strings that look like a stable error code
 * (`UPPER_SNAKE_CASE` or `A-Z0-9_`). Free-form messages like
 * `"User 42 is not authorised"` would otherwise land on
 * `jetstream.rpc.reply.error.code` — producing high-cardinality APM
 * series and leaking PII through span exports.
 */
const STABLE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]*$/u;

const isStableErrorCode = (value: string): boolean => STABLE_ERROR_CODE_RE.test(value);

const codeFromPayload = (payload: unknown): string | undefined => {
  if (payload === null || payload === undefined) return undefined;
  if (typeof payload === 'string') return isStableErrorCode(payload) ? payload : undefined;
  if (typeof payload === 'object') {
    const code = (payload as { code?: unknown }).code;

    if (typeof code === 'string' && isStableErrorCode(code)) return code;
  }

  return undefined;
};

/**
 * Attributes for a span whose handler threw an error classified as
 * `expected`. Span stays OK, attributes surface the business outcome.
 * The error message is intentionally not captured (PII risk — add it via
 * `responseHook` if you want it).
 */
export const buildExpectedErrorAttributes = (err: unknown): Attributes => {
  const attrs: Attributes = {
    [ATTR_JETSTREAM_RPC_REPLY_HAS_ERROR]: true,
  };
  const code = extractExpectedErrorCode(err);

  if (code !== undefined) attrs[ATTR_JETSTREAM_RPC_REPLY_ERROR_CODE] = code;

  return attrs;
};

/** Apply the expected-error attributes to an already-started span — shared by the consume and RPC-client paths. */
export const applyExpectedErrorAttributes = (span: Span, err: unknown): void => {
  span.setAttributes(buildExpectedErrorAttributes(err));
};
