import { JetStreamApiError } from '@nats-io/jetstream';

import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { PublishErrorReason } from '../errors.types';
import { isJetstreamError } from '../jetstream-error';
import { JetstreamPublishError, toPublishError } from '../publish-error';

const STORE_FAILED = 10077;

const apiError = (description: string): JetStreamApiError =>
  new JetStreamApiError({ err_code: STORE_FAILED, code: 503, description });

describe(toPublishError, () => {
  it.each([
    'maximum messages exceeded',
    'maximum bytes exceeded',
    'maximum messages per subject exceeded',
  ])('should report "%s" as a full stream', (description) => {
    // Given
    const original = apiError(description);

    // When
    const sut = toPublishError(original);

    // Then
    expect(sut).toBeInstanceOf(JetstreamPublishError);
    expect(sut).toBeInstanceOf(JetStreamApiError);
    expect(isJetstreamError(sut)).toBe(true);
    expect(sut).toMatchObject({
      name: 'JetstreamPublishError',
      reason: PublishErrorReason.StreamFull,
      code: original.code,
      status: original.status,
      message: original.message,
      cause: original,
    });
  });

  it('should pass any other api error through unchanged', () => {
    // Given
    const original = new JetStreamApiError({
      err_code: 10071,
      code: 400,
      description: 'wrong last sequence: 3',
    });

    // When / Then
    expect(toPublishError(original)).toBe(original);
  });

  it('should pass a non-api error through unchanged', () => {
    // Given
    const original = new Error(faker.lorem.sentence());

    // When / Then
    expect(toPublishError(original)).toBe(original);
  });
});
