import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionRegistry } from '../connection/connection-registry';
import type { ConnectionScope } from '../connection/connection.types';
import { assertAllConnectionsStarted } from '../jetstream.module';

interface ScopeState {
  /** `null` means a publisher-only connection, which owns no strategy. */
  attached: boolean | null;
  started?: boolean;
  critical?: boolean;
}

const scope = (name: string, state: ScopeState): ConnectionScope =>
  createMock<ConnectionScope>({
    name,
    critical: state.critical ?? true,
    strategy:
      state.attached === null
        ? null
        : createMock({ isAttached: state.attached, isStarted: state.started ?? state.attached }),
  });

const registryOf = (scopes: ConnectionScope[]): ConnectionRegistry =>
  new ConnectionRegistry(new Map(scopes.map((s) => [s.name, s])), scopes[0]?.name ?? 'default');

describe('assertAllConnectionsStarted', () => {
  afterEach(vi.resetAllMocks);

  it('should pass when a single connection never started', () => {
    // Given one connection, which a non-hybrid app may legitimately not start
    const sut = registryOf([scope('default', { attached: false })]);

    // When asserted, Then nothing is thrown
    expect(() => {
      assertAllConnectionsStarted(sut);
    }).not.toThrow();
  });

  it('should pass when every configured connection was attached', () => {
    // Given two attached connections
    const sut = registryOf([
      scope('primary', { attached: true }),
      scope('analytics', { attached: true }),
    ]);

    // When asserted, Then nothing is thrown
    expect(() => {
      assertAllConnectionsStarted(sut);
    }).not.toThrow();
  });

  it('should ignore publisher-only connections', () => {
    // Given an attached consumer and a strategy-less publisher
    const sut = registryOf([
      scope('primary', { attached: true }),
      scope('analytics', { attached: null }),
    ]);

    // When asserted, Then nothing is thrown
    expect(() => {
      assertAllConnectionsStarted(sut);
    }).not.toThrow();
  });

  it('should name the connections that were never attached', () => {
    // Given a second connection that the bootstrap forgot
    const sut = registryOf([
      scope('primary', { attached: true }),
      scope('analytics', { attached: false }),
    ]);

    // When asserted, Then the message is actionable
    expect(() => {
      assertAllConnectionsStarted(sut);
    }).toThrow(/analytics[\s\S]*connectJetstreamMicroservices/);
  });

  it('should not fault a non-critical connection that is still starting', () => {
    // Given a non-critical connection attached by the bootstrap whose boot chain
    // has not finished — the whole point of critical: false is that this is fine
    const sut = registryOf([
      scope('primary', { attached: true }),
      scope('analytics', { attached: true, started: false, critical: false }),
    ]);

    // When asserted, Then startup is not aborted
    expect(() => {
      assertAllConnectionsStarted(sut);
    }).not.toThrow();
  });

  it('should not fault a critical connection that is still starting', () => {
    // Given a critical connection that was attached but is mid-boot: NestJS may
    // run onApplicationBootstrap before listen() resolves
    const sut = registryOf([
      scope('primary', { attached: true }),
      scope('audit', { attached: true, started: false }),
    ]);

    // When asserted, Then attachment is what matters, not completion
    expect(() => {
      assertAllConnectionsStarted(sut);
    }).not.toThrow();
  });

  it('should stay silent when nothing is attached yet', () => {
    // Given the documented hybrid order, where init() and therefore this hook
    // runs before startAllMicroservices() attaches anything
    const sut = registryOf([
      scope('primary', { attached: false }),
      scope('analytics', { attached: false }),
    ]);

    // When asserted, Then the check is simply premature and must not fire
    expect(() => {
      assertAllConnectionsStarted(sut);
    }).not.toThrow();
  });
});
