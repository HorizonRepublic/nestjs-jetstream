import { trace, type Tracer } from '@opentelemetry/api';

import { TRACER_NAME } from './constants';

/**
 * Package version replaced at build time by tsup's `define`. When the
 * module is imported straight from source (integration tests, tsx), the
 * identifier isn't defined and we fall back to `0.0.0` — only affects
 * the `instrumentation.scope.version` span attribute.
 */
/* eslint-disable-next-line @typescript-eslint/naming-convention -- build-time identifier */
declare const __PACKAGE_VERSION__: string;
const PACKAGE_VERSION = typeof __PACKAGE_VERSION__ === 'string' ? __PACKAGE_VERSION__ : '0.0.0';

/**
 * Resolve the OpenTelemetry tracer for the library's instrumentation scope.
 * `trace.getTracer` already caches the per-provider instance internally — a
 * second cache here would freeze a no-op tracer for the rest of the process
 * if the host application registers an SDK after the first call.
 */
export const getTracer = (): Tracer => trace.getTracer(TRACER_NAME, PACKAGE_VERSION);
