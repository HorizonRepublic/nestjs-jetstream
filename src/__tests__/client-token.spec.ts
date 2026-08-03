import { faker } from '@faker-js/faker';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getClientToken } from '../jetstream.constants';

describe('getClientToken', () => {
  afterEach(vi.resetAllMocks);

  it('should return the bare service name for the default connection', () => {
    // Given a service name
    const name = faker.word.noun();

    // When no connection is supplied
    const sut = getClientToken(name);

    // Then the pre-3.0 token shape is preserved
    expect(sut).toBe(name);
  });

  it('should namespace the token when a connection is supplied', () => {
    // Given a service name and a connection
    // When the token is built
    const sut = getClientToken('sink', 'analytics');

    // Then the connection prefixes it
    expect(sut).toBe('analytics::sink');
  });

  it('should keep tokens for the same service on different connections distinct', () => {
    // Given one service reachable on two connections
    // When tokens are built
    // Then they differ
    expect(getClientToken('sink', 'analytics')).not.toBe(getClientToken('sink', 'primary'));
  });
});
