import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionRegistry } from '../connection/connection-registry';
import type { ConnectionScope } from '../connection/connection.types';
import { assertAllConnectionsStarted } from '../jetstream.module';

const scope = (name: string, started: boolean | null): ConnectionScope =>
  createMock<ConnectionScope>({
    name,
    strategy: started === null ? null : createMock({ isStarted: started }),
  });

const registryOf = (scopes: ConnectionScope[]): ConnectionRegistry =>
  new ConnectionRegistry(new Map(scopes.map((s) => [s.name, s])), scopes[0]?.name ?? 'default');

describe('assertAllConnectionsStarted', () => {
  afterEach(vi.resetAllMocks);

  it('should pass when a single connection never started', () => {
    // Given one connection, which a non-hybrid app may legitimately not start
    const sut = registryOf([scope('default', false)]);

    // When asserted, Then nothing is thrown
    expect(() => {
      assertAllConnectionsStarted(sut);
    }).not.toThrow();
  });

  it('should pass when every configured connection started', () => {
    // Given two started connections
    const sut = registryOf([scope('primary', true), scope('analytics', true)]);

    // When asserted, Then nothing is thrown
    expect(() => {
      assertAllConnectionsStarted(sut);
    }).not.toThrow();
  });

  it('should ignore publisher-only connections', () => {
    // Given a started consumer and a strategy-less publisher
    const sut = registryOf([scope('primary', true), scope('analytics', null)]);

    // When asserted, Then nothing is thrown
    expect(() => {
      assertAllConnectionsStarted(sut);
    }).not.toThrow();
  });

  it('should name the unstarted connections and point at the helper', () => {
    // Given a second connection that was never attached
    const sut = registryOf([scope('primary', true), scope('analytics', false)]);

    // When asserted, Then the message is actionable
    expect(() => {
      assertAllConnectionsStarted(sut);
    }).toThrow(/analytics[\s\S]*connectJetstreamMicroservices/);
  });
});
