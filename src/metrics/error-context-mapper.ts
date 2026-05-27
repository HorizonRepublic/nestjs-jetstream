import type { ErrorContext } from './metrics.config';
import { ERROR_CONTEXT_PREFIXES } from './metrics.constants';

/**
 * Resolves a free-form `TransportEvent.Error` context to a bounded
 * {@link ErrorContext} via prefix match against {@link ERROR_CONTEXT_PREFIXES}.
 * Unknown/missing contexts collapse to `'other'`.
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
