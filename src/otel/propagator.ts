import {
  propagation,
  type Context,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';

/**
 * Inject the active trace context into the carrier using whatever
 * propagator the host application registered. Per the
 * [OpenTelemetry Propagators API spec][spec], instrumentation libraries
 * MUST NOT bundle a fallback propagator; with no SDK registered the global
 * propagator is a no-op and this call writes nothing.
 *
 * [spec]: https://opentelemetry.io/docs/specs/otel/context/api-propagators/
 */
export const injectContext = <T>(ctx: Context, carrier: T, setter: TextMapSetter<T>): void => {
  propagation.inject(ctx, carrier, setter);
};

/**
 * Extract a trace context from the carrier using whatever propagator the
 * host application registered. With no SDK registered the returned context
 * equals the one passed in (typically `ROOT_CONTEXT`), so consumers create
 * parentless spans, which is correct for an untraced app.
 */
export const extractContext = <T>(ctx: Context, carrier: T, getter: TextMapGetter<T>): Context =>
  propagation.extract(ctx, carrier, getter);
