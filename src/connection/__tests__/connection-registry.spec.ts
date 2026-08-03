import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionRegistry } from '../connection-registry';
import type { ConnectionScope } from '../connection.types';

const scope = (name: string): ConnectionScope => createMock<ConnectionScope>({ name });

describe('ConnectionRegistry', () => {
  afterEach(vi.resetAllMocks);

  it('should return the default scope', () => {
    // Given two registered scopes
    const primary = scope('primary');
    const sut = new ConnectionRegistry(
      new Map([
        ['primary', primary],
        ['analytics', scope('analytics')],
      ]),
      'primary',
    );

    // When the default is requested
    // Then the declared default comes back
    expect(sut.getDefault()).toBe(primary);
    expect(sut.defaultName).toBe('primary');
  });

  it('should list names in registration order', () => {
    // Given scopes registered in a known order
    const sut = new ConnectionRegistry(
      new Map([
        ['primary', scope('primary')],
        ['analytics', scope('analytics')],
      ]),
      'primary',
    );

    // When names are listed
    // Then order is preserved
    expect(sut.names()).toEqual(['primary', 'analytics']);
    expect(sut.all()).toHaveLength(2);
  });

  it('should report membership', () => {
    // Given one scope
    const sut = new ConnectionRegistry(new Map([['primary', scope('primary')]]), 'primary');

    // When membership is checked
    // Then only registered names match
    expect(sut.has('primary')).toBe(true);
    expect(sut.has('analytics')).toBe(false);
  });

  it('should throw with the known names on an unknown lookup', () => {
    // Given one scope
    const sut = new ConnectionRegistry(new Map([['primary', scope('primary')]]), 'primary');

    // When an unknown connection is requested
    // Then the error names what is configured
    expect(() => sut.get('analytics')).toThrow(/Unknown connection "analytics"[\s\S]*primary/);
  });
});
