import { JetStreamApiError, type ApiError } from '@nats-io/jetstream';

import { NatsErrorCode } from '../server/infrastructure/nats-error-codes';
import { PublishErrorReason } from './errors.types';
import { brandJetstreamError } from './jetstream-error';

const STREAM_FULL_DESCRIPTIONS: ReadonlySet<string> = new Set([
  'maximum messages exceeded',
  'maximum bytes exceeded',
  'maximum messages per subject exceeded',
]);

/**
 * The server rejected a publish. Extends `JetStreamApiError`, so code that
 * already handles the raw nats.js error keeps working.
 */
export class JetstreamPublishError extends JetStreamApiError {
  public readonly reason: PublishErrorReason;

  public constructor(reason: PublishErrorReason, apiError: ApiError, options?: ErrorOptions) {
    super(apiError, options);
    this.name = 'JetstreamPublishError';
    this.reason = reason;
    brandJetstreamError(this);
  }
}

/** Wraps a full-stream rejection in `JetstreamPublishError`; returns anything else as is. */
export const toPublishError = (error: unknown): unknown => {
  if (!(error instanceof JetStreamApiError)) return error;

  const apiError = error.apiError();

  if (
    apiError.err_code !== NatsErrorCode.StreamStoreFailed ||
    !STREAM_FULL_DESCRIPTIONS.has(apiError.description)
  ) {
    return error;
  }

  return new JetstreamPublishError(PublishErrorReason.StreamFull, apiError, { cause: error });
};
