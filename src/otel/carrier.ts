import type { TextMapGetter, TextMapSetter } from '@opentelemetry/api';
import type { MsgHdrs } from '@nats-io/transport-node';

/**
 * `TextMapSetter` that writes propagation keys (`traceparent`, `tracestate`,
 * `baggage`, and any other propagator-declared fields) onto a NATS `MsgHdrs`
 * instance. Uses `set()` rather than `append()` so repeated injections
 * replace prior values instead of accumulating.
 */
export const hdrsSetter: TextMapSetter<MsgHdrs> = {
  set: (headers, key, value) => {
    headers.set(key, value);
  },
};

/**
 * `TextMapGetter` that reads propagation keys from a NATS `MsgHdrs`
 * instance. Normalizes empty-string returns to `undefined` since NATS
 * `MsgHdrs.get()` returns `''` when a key is absent.
 *
 * Multi-valued headers are joined with `,` — matches the W3C Baggage and
 * Trace Context list-header convention, and W3C `traceparent` never occurs
 * as a real multi-value so the join is a no-op on the common path. Using
 * `values(key)` when available means composite propagators that produce a
 * multi-value `baggage`/`tracestate` across publishers don't silently drop
 * entries. Falls back to `get(key)` if the carrier does not expose
 * `values` (e.g. a partial test double).
 */
export const hdrsGetter: TextMapGetter<MsgHdrs | undefined> = {
  keys: (headers) => (headers ? headers.keys() : []),
  get: (headers, key) => {
    if (!headers) return undefined;

    const all = typeof headers.values === 'function' ? headers.values(key) : undefined;

    if (Array.isArray(all)) {
      if (all.length === 0) return undefined;
      const joined = all.join(',');

      return joined === '' ? undefined : joined;
    }

    const single = headers.get(key);

    return single === '' ? undefined : single;
  },
};
