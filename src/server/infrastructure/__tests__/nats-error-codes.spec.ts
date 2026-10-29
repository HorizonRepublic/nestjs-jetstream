import { JetStreamApiError } from '@nats-io/jetstream';

import { describe, expect, it } from 'vitest';

import { isNatsError, natsErrorCode, NatsErrorCode } from '../nats-error-codes';

const apiError = (errCode: NatsErrorCode): JetStreamApiError =>
  new JetStreamApiError({ err_code: errCode, code: 404, description: 'stream not found' });

describe('natsErrorCode', () => {
  it('should read the err_code of a JetStream API error', () => {
    expect(natsErrorCode(apiError(NatsErrorCode.StreamNotFound))).toBe(
      NatsErrorCode.StreamNotFound,
    );
  });

  it.each([new Error('timeout'), 'boom', undefined])('should return undefined for %s', (err) => {
    expect(natsErrorCode(err)).toBeUndefined();
  });
});

describe('isNatsError', () => {
  it('should match a JetStream API error with the given code', () => {
    expect(isNatsError(apiError(NatsErrorCode.StreamNotFound), NatsErrorCode.StreamNotFound)).toBe(
      true,
    );
  });

  it('should not match another code', () => {
    expect(
      isNatsError(apiError(NatsErrorCode.ConsumerNotFound), NatsErrorCode.StreamNotFound),
    ).toBe(false);
  });

  it('should not match an error that is not a JetStream API error', () => {
    expect(isNatsError(new Error('timeout'), NatsErrorCode.StreamNotFound)).toBe(false);
  });
});
