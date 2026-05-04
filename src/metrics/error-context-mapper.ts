import type { ErrorContext } from './metrics.config';
import { ERROR_CONTEXT_PREFIXES } from './metrics.constants';

/**
 * Resolve a free-form error context string (as emitted via
 * `TransportEvent.Error`) to a bounded {@link ErrorContext} label suitable
 * for use as a Prometheus label value.
 *
 * Matching is prefix-based against {@link ERROR_CONTEXT_PREFIXES}. Unknown
 * or missing contexts collapse to `'other'` so cardinality stays bounded.
 */
export const mapErrorContext = (context: string | undefined): ErrorContext => {
  if (!context) return 'other';

  for (const [prefix, mapped] of ERROR_CONTEXT_PREFIXES) {
    if (context === prefix || context.startsWith(`${prefix}:`)) {
      return mapped;
    }
  }

  return 'other';
};
