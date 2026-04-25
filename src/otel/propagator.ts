import {
  propagation,
  type Context,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';

/**
 * Inject the active trace context into the carrier using whatever
 * propagator the host application registered via the OpenTelemetry SDK.
 * Per the [OpenTelemetry Propagators API spec][spec], instrumentation
 * libraries MUST NOT bundle their own fallback propagator — if no SDK is
 * registered, the global propagator is a no-op and this call writes
 * nothing, which is correct: there is no active span to propagate.
 *
 * [spec]: https://opentelemetry.io/docs/specs/otel/context/api-propagators/
 */
export const injectContext = <T>(ctx: Context, carrier: T, setter: TextMapSetter<T>): void => {
  propagation.inject(ctx, carrier, setter);
};

/**
 * Extract a trace context from the carrier using whatever propagator the
 * host application registered. When no SDK is registered the global
 * propagator is a no-op and the returned context is the same one passed
 * in (typically `ROOT_CONTEXT`) — consumers then create their spans
 * without a parent, which is the correct behaviour for an app that
 * hasn't configured tracing.
 */
export const extractContext = <T>(ctx: Context, carrier: T, getter: TextMapGetter<T>): Context =>
  propagation.extract(ctx, carrier, getter);
