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
 * Invoke a user hook with a try/catch so a broken hook can't break the
 * message path. Hooks are documented as synchronous, but TypeScript widens
 * `Promise<void>` to `void`, so an `async` hook compiles cleanly. Both
 * synchronous throws and async rejections are swallowed and logged at
 * `debug` so they don't add noise to prod logs but are still available
 * during diagnosis.
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
    // The public hook signature is `(...args) => void`, but TypeScript
    // assigns `Promise<void>` to `void`, so an async user hook reaches us
    // returning a thenable. Cast through `unknown` so we can detect that
    // and forward rejections instead of leaking them as unhandled.
    const result: unknown = (hook as (...args: A) => unknown)(...args);

    if (result !== null && typeof result === 'object' && 'then' in result) {
      const promise = result as PromiseLike<unknown>;

      promise.then(undefined, logHookFailure);
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
 * span attributes — **not** NATS URL validation. If the user misconfigures
 * `servers`, the NATS client itself surfaces a real connection error long
 * before tracing matters; our job here is just to reflect what the user
 * configured as far as we can parse it.
 *
 * Only `servers[0]` is inspected — NATS client-side failover picks the
 * reachable entry at runtime, and the actual connected URL is surfaced
 * separately via the connection-lifecycle span (`NatsConnection.getServer()`).
 *
 * Returns `null` when nothing useful can be extracted; the caller skips
 * the server.* attributes rather than inventing `localhost:4222`.
 */
export const parseServerAddress = (servers: readonly string[]): ServerEndpoint | null => {
  const raw = servers[0];

  if (!raw) return null;

  // Scheme-qualified — WHATWG URL handles `nats://` / `tls://` / `ws://`
  // / `wss://`, userinfo, and IPv6 brackets uniformly.
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

  // Bare IPv6 authority `[::1]:port` — URL rejects it without scheme.
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

/**
 * Config bundle surfaced by {@link deriveOtelAttrs} — the three values
 * every span-emitting provider or router holds on to for the lifetime of
 * the module.
 */
export interface DerivedOtelAttrs {
  readonly otel: ResolvedOtelOptions;
  readonly serviceName: string;
  readonly serverEndpoint: ServerEndpoint | null;
}

/**
 * Derive the OTel attribute bundle every router / provider holds onto.
 * `serverEndpoint` may be `null` when the configured NATS URL can't be
 * parsed — downstream attribute builders then skip the `server.*`
 * keys rather than inventing a value.
 */
export const deriveOtelAttrs = (options: {
  readonly otel?: OtelOptions;
  readonly name: string;
  readonly servers: readonly string[];
}): DerivedOtelAttrs => ({
  otel: resolveOtelOptions(options.otel),
  serviceName: internalName(options.name),
  serverEndpoint: parseServerAddress(options.servers),
});
