import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { errorMessage, toError } from '../to-error';

describe(toError.name, () => {
  it('should return an Error as is', () => {
    // Given
    const err = new Error(faker.lorem.sentence());

    // When / Then
    expect(toError(err)).toBe(err);
  });

  it('should wrap any other value in an Error carrying its string form', () => {
    // When
    const result = toError(42);

    // Then
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('42');
  });
});

describe(errorMessage.name, () => {
  it('should return the message of an Error', () => {
    // Given
    const message = faker.lorem.sentence();

    // When / Then
    expect(errorMessage(new Error(message))).toBe(message);
  });

  it('should return the string form of any other value', () => {
    expect(errorMessage('boom')).toBe('boom');
  });
});
