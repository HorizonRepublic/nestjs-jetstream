import type { Attributes } from '@opentelemetry/api';
import type { MsgHdrs } from '@nats-io/transport-node';

import {
  ATTR_MESSAGING_NATS_BODY,
  ATTR_MESSAGING_NATS_BODY_TRUNCATED,
  messagingHeaderAttr,
} from './attribute-keys';
import type { HeaderMatcher } from './config';

const NEGATION_PREFIX = '!';
// `*` is deliberately included in the regex-meta class: `escapeForRegex`
// must turn it into `\*` so the subsequent `replace(/\\\*/, '.*')` in
// `globToRegex` can distinguish a glob wildcard from any other meta char.
// Don't drop `*` from this class — wildcards stop working.
const REGEX_SPECIAL_RE = /[.+?^${}()|[\]\\*]/gu;

const escapeForRegex = (input: string): string => input.replace(REGEX_SPECIAL_RE, '\\$&');

const globToRegex = (glob: string): RegExp => {
  const escaped = escapeForRegex(glob.toLowerCase()).replace(/\\\*/gu, '.*');

  return new RegExp(`^${escaped}$`, 'u');
};

/**
 * Compile a `captureHeaders` allowlist into a {@link HeaderMatcher}
 * predicate. Accepts:
 *
 * - `true` — match every header (dev only — see security note)
 * - `false` or empty array — match nothing
 * - `string[]` — case-insensitive glob match. Each pattern supports `*`
 *   wildcards. A leading `!` marks an exclusion that runs after the
 *   include list — `['x-*', '!x-internal-*']` keeps `x-correlation-id`
 *   while dropping `x-internal-secret`.
 */
export const compileHeaderAllowlist = (allowlist: readonly string[] | boolean): HeaderMatcher => {
  if (allowlist === true) return () => true;
  if (allowlist === false) return () => false;
  if (allowlist.length === 0) return () => false;

  const includes: RegExp[] = [];
  const excludes: RegExp[] = [];

  for (const pattern of allowlist) {
    const isExclude = pattern.startsWith(NEGATION_PREFIX);
    const body = isExclude ? pattern.slice(NEGATION_PREFIX.length) : pattern;
    const regex = globToRegex(body);

    if (isExclude) excludes.push(regex);
    else includes.push(regex);
  }

  return (name: string): boolean => {
    const lower = name.toLowerCase();

    if (!includes.some((re) => re.test(lower))) return false;
    if (excludes.some((re) => re.test(lower))) return false;

    return true;
  };
};

/** Pre-compiled subject allowlist, cached per allowlist array identity. */
type SubjectMatcher = (subject: string) => boolean;

const subjectMatcherCache = new WeakMap<readonly string[], SubjectMatcher>();

/**
 * Compile a `subjectAllowlist` into a reusable matcher. Supports the same
 * `*` wildcards as {@link compileHeaderAllowlist}; negation is not
 * accepted — the allowlist is purely positive. Undefined / empty allowlist
 * matches every subject.
 */
export const compileSubjectAllowlist = (
  allowlist: readonly string[] | undefined,
): SubjectMatcher => {
  if (!allowlist || allowlist.length === 0) return () => true;
  const cached = subjectMatcherCache.get(allowlist);

  if (cached) return cached;

  const regexes = allowlist.map(globToRegex);
  const matcher: SubjectMatcher = (subject: string): boolean => {
    const lower = subject.toLowerCase();

    return regexes.some((re) => re.test(lower));
  };

  subjectMatcherCache.set(allowlist, matcher);

  return matcher;
};

/**
 * Glob-match a subject against a static allowlist (used for body capture
 * scoping). Convenience wrapper around {@link compileSubjectAllowlist} for
 * one-off calls.
 */
export const subjectMatchesAllowlist = (
  subject: string,
  allowlist: readonly string[] | undefined,
): boolean => compileSubjectAllowlist(allowlist)(subject);

/**
 * Names of headers we never expose as `messaging.header.*` attributes —
 * they are either propagator-owned (read by OTel/W3C/B3 directly) or
 * library-internal (correlation ID, reply-to, error flag) and would be
 * noise on every span.
 */
const HEADER_DENYLIST = new Set<string>([
  'traceparent',
  'tracestate',
  'baggage',
  'sentry-trace',
  'b3',
  'x-b3-traceid',
  'x-b3-spanid',
  'x-b3-parentspanid',
  'x-b3-sampled',
  'x-b3-flags',
  'uber-trace-id',
  'x-correlation-id',
  'x-reply-to',
  'x-error',
  'x-subject',
  'x-caller-name',
  'nats-msg-id',
]);

/**
 * Read the headers that pass the allowlist matcher and return them as
 * span attributes keyed by `messaging.header.<lowercase-name>`.
 */
export const captureMatchingHeaders = (
  headers: MsgHdrs | undefined,
  matcher: HeaderMatcher,
): Attributes => {
  if (!headers) return {};
  const out: Attributes = {};

  for (const key of headers.keys()) {
    const lower = key.toLowerCase();

    if (HEADER_DENYLIST.has(lower)) continue;
    if (!matcher(key)) continue;
    const value = headers.get(key);

    if (value === '') continue;
    out[messagingHeaderAttr(lower)] = value;
  }

  return out;
};

const tryUtf8Decode = (bytes: Uint8Array): string => {
  // `fatal: false` so a valid UTF-8 payload truncated mid-codepoint (the
  // common case when `maxBytes` clips a 2/3/4-byte sequence) decodes with
  // a trailing U+FFFD replacement instead of throwing and silently
  // collapsing the whole attribute to base64.
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    // Strictly binary payload — base64 is the legible fallback.
    return Buffer.from(bytes).toString('base64');
  }
};

/**
 * Truncate-and-decode a payload into a span attribute value. Returns
 * an empty object when capture is disabled, when the subject does not
 * match the configured allowlist, or when the payload is empty.
 */
export const captureBodyAttribute = (
  subject: string,
  payload: Uint8Array,
  capture: false | { readonly maxBytes: number; readonly subjectAllowlist?: readonly string[] },
): Attributes => {
  if (capture === false) return {};
  if (payload.byteLength === 0) return {};
  if (!subjectMatchesAllowlist(subject, capture.subjectAllowlist)) return {};

  const { maxBytes } = capture;
  const truncated = payload.byteLength > maxBytes;
  const slice = truncated ? payload.subarray(0, maxBytes) : payload;
  const decoded = tryUtf8Decode(slice);
  const out: Attributes = { [ATTR_MESSAGING_NATS_BODY]: decoded };

  if (truncated) out[ATTR_MESSAGING_NATS_BODY_TRUNCATED] = true;

  return out;
};
