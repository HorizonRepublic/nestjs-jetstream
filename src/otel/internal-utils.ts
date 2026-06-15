import { Logger } from '@nestjs/common';

import { internalName } from '../jetstream.constants';

import {
  resolveOtelOptions,
  type OtelOptions,
  type ResolvedOtelOptions,
  type ServerEndpoint,
} from './config';

const logger = new Logger('Jetstream:Otel');

/**
 * Invoke a user hook so a broken hook can't break the message path. Hooks
 * are documented as synchronous, but TypeScript assigns `Promise<void>` to
 * `void`, so async hooks compile; both throws and rejections are swallowed
 * and logged at debug level.
 */
export const safelyInvokeHook = <A extends readonly unknown[]>(
  hookName: string,
  hook: ((...args: A) => void) | undefined,
  ...args: A
): void => {
  if (!hook) return;

  const logHookFailure = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);

    logger.debug(`OTel ${hookName} threw: ${message}`);
  };

  try {
    // Async hooks return a thenable despite the `void` signature; detect it
    // and forward rejections instead of leaking them as unhandled.
    const result: unknown = (hook as (...args: A) => unknown)(...args);

    if (
      result !== null &&
      typeof result === 'object' &&
      'then' in result &&
      typeof (result as { then: unknown }).then === 'function'
    ) {
      (result as PromiseLike<unknown>).then(undefined, logHookFailure);
    }
  } catch (err) {
    logHookFailure(err);
  }
};

const stripIpv6Brackets = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

const parsePort = (portRaw: string | undefined): number | undefined => {
  if (!portRaw) return undefined;
  const port = Number.parseInt(portRaw, 10);

  return Number.isInteger(port) ? port : undefined;
};

/**
 * Best-effort host/port extraction for the `server.address` / `server.port`
 * span attributes, not NATS URL validation. Only `servers[0]` is inspected;
 * the actually-connected URL is surfaced by the connection-lifecycle span.
 * Returns `null` when nothing useful can be extracted, and the caller then
 * skips the `server.*` attributes rather than inventing `localhost:4222`.
 */
export const parseServerAddress = (servers: readonly string[]): ServerEndpoint | null => {
  const raw = servers[0];

  if (!raw) return null;

  // Scheme-qualified: WHATWG URL handles all NATS schemes, userinfo, and IPv6 brackets.
  if (raw.includes('://')) {
    try {
      const url = new URL(raw);

      if (url.hostname.length === 0) return null;
      const host = stripIpv6Brackets(url.hostname);
      const port = parsePort(url.port || undefined);

      return port === undefined ? { host } : { host, port };
    } catch {
      return null;
    }
  }

  // Bare IPv6 authority `[::1]:port`; URL rejects it without a scheme.
  if (raw.startsWith('[')) {
    const closeIdx = raw.indexOf(']');

    if (closeIdx <= 0) return null;
    const host = raw.slice(1, closeIdx);
    const port = parsePort(raw.slice(closeIdx + 1).replace(/^:/u, ''));

    return port === undefined ? { host } : { host, port };
  }

  // Bare `host:port`.
  const [host, portRaw] = raw.split(':');

  if (!host) return null;
  const port = parsePort(portRaw);

  return port === undefined ? { host } : { host, port };
};

/** Bundle from {@link deriveOtelAttrs}, held by span-emitting providers for the module lifetime. */
export interface DerivedOtelAttrs {
  readonly otel: ResolvedOtelOptions;
  readonly serviceName: string;
  readonly serverEndpoint: ServerEndpoint | null;
}

/**
 * Derive the OTel attribute bundle every router / provider holds onto.
 * `serverEndpoint` is `null` when the configured NATS URL can't be parsed;
 * attribute builders then skip the `server.*` keys.
 */
export const deriveOtelAttrs = (options: {
  readonly otel?: OtelOptions | boolean;
  readonly name: string;
  readonly servers: readonly string[];
}): DerivedOtelAttrs => ({
  otel: resolveOtelOptions(options.otel),
  serviceName: internalName(options.name),
  serverEndpoint: parseServerAddress(options.servers),
});
