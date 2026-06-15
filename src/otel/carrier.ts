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
 * instance. Normalizes empty strings to `undefined` since `MsgHdrs.get()`
 * returns `''` for absent keys. Multi-valued headers are joined with `,`
 * per the W3C list-header convention, via `values(key)` when the carrier
 * exposes it so multi-value `baggage` / `tracestate` entries aren't dropped.
 */
export const hdrsGetter: TextMapGetter<MsgHdrs | undefined> = {
  keys: (headers) => (headers ? headers.keys() : []),
  get: (headers, key) => {
    if (!headers) return undefined;

    const all = typeof headers.values === 'function' ? headers.values(key) : undefined;

    if (Array.isArray(all)) {
      // Drop empty entries so `['', '']` yields `undefined`, matching the single-value branch.
      const nonEmpty = all.filter((value) => value !== '');

      if (nonEmpty.length === 0) return undefined;

      return nonEmpty.join(',');
    }

    const single = headers.get(key);

    return single === '' ? undefined : single;
  },
};
