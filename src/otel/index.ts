// Public surface — re-exported from `src/index.ts` for library consumers.
export { TRACER_NAME } from './constants';

// Internal sharing — attribute / span-name constants used across `src/`
// modules. Not re-exported from `src/index.ts`, so they stay out of the
// public `.d.ts` / typedoc output.
export * from './attribute-keys';

export { JetstreamTrace, DEFAULT_TRACES } from './trace-kinds';

export { ConsumeKind, PublishKind } from './config';

export type {
  CaptureBodyOptions,
  ConsumeSourceMsg,
  ErrorClassification,
  HandlerMetadata,
  JetstreamConsumeContext,
  JetstreamPublishContext,
  JetstreamResponseContext,
  OtelOptions,
  ServerEndpoint,
} from './config';

// Internal surface — consumed by other `src/` modules, not re-exported from the root.
export { resolveOtelOptions } from './config';

export type { HeaderMatcher, ResolvedOtelOptions } from './config';

export { deriveOtelAttrs, parseServerAddress, safelyInvokeHook } from './internal-utils';

export type { DerivedOtelAttrs } from './internal-utils';

export { injectContext, extractContext } from './propagator';

export { getTracer } from './tracer';

export { hdrsGetter, hdrsSetter } from './carrier';

export {
  applyExpectedErrorAttributes,
  buildConsumeAttributes,
  buildDeadLetterAttributes,
  buildExpectedErrorAttributes,
  buildPublishAttributes,
  buildRpcClientAttributes,
} from './attributes';

export type {
  ConsumeAttributeContext,
  DeadLetterAttributeContext,
  MessagingBaseContext,
  PublishAttributeContext,
  RpcClientAttributeContext,
} from './attributes';

export { withPublishSpan } from './spans/publish';

export type { PublishSpanContext } from './spans/publish';

export { withConsumeSpan } from './spans/consume';

export type { ConsumeSpanContext, ConsumeSpanOptions } from './spans/consume';

export { beginRpcClientSpan, RPC_TIMEOUT_MESSAGE, RpcOutcomeKind } from './spans/rpc-client';

export type { RpcClientSpanContext, RpcClientSpanHandle, RpcOutcome } from './spans/rpc-client';

export { withDeadLetterSpan } from './spans/dead-letter';

export type { DeadLetterSpanContext } from './spans/dead-letter';

export {
  beginConnectionLifecycleSpan,
  withMigrationSpan,
  withProvisioningSpan,
  withSelfHealingSpan,
  withShutdownSpan,
} from './spans/infrastructure';

export type {
  ConnectionLifecycleSpanContext,
  ConnectionLifecycleSpanHandle,
  InfrastructureSpanContext,
  MigrationSpanContext,
  ProvisioningAction,
  ProvisioningEntity,
  ProvisioningSpanContext,
  SelfHealingSpanContext,
  SpanEventAttributes,
} from './spans/infrastructure';
