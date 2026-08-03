import { faker } from '@faker-js/faker';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JetstreamModuleOptions } from '../../interfaces';
import { normalizeOptions } from '../connection-options';

describe('normalizeOptions', () => {
  afterEach(vi.resetAllMocks);

  it('should rewrite the flat form into a single default connection', () => {
    // Given a v2-style flat configuration
    const servers = [`nats://${faker.internet.domainName()}:4222`];
    const options: JetstreamModuleOptions = { name: 'orders', servers };

    // When normalized
    const sut = normalizeOptions(options);

    // Then one connection named "default" carries the servers
    expect(sut.defaultConnection).toBe('default');
    expect(sut.connections).toHaveLength(1);
    expect(sut.connections[0]?.connectionName).toBe('default');
    expect(sut.connections[0]?.servers).toEqual(servers);
    expect(sut.connections[0]?.critical).toBe(true);
  });

  it('should merge root options under connection options', () => {
    // Given a root-level override and a connection that redefines one field
    const options: JetstreamModuleOptions = {
      name: 'orders',
      shutdownTimeout: 5_000,
      events: { concurrency: 4 },
      connections: {
        primary: { servers: ['nats://a:4222'] },
        analytics: { servers: ['nats://b:4222'], events: { concurrency: 16 }, critical: false },
      },
      defaultConnection: 'primary',
    };

    // When normalized
    const sut = normalizeOptions(options);
    const primary = sut.connections.find((c) => c.connectionName === 'primary');
    const analytics = sut.connections.find((c) => c.connectionName === 'analytics');

    // Then the root value is inherited and the connection value wins where set
    expect(primary?.events?.concurrency).toBe(4);
    expect(primary?.shutdownTimeout).toBe(5_000);
    expect(primary?.critical).toBe(true);
    expect(analytics?.events?.concurrency).toBe(16);
    expect(analytics?.shutdownTimeout).toBe(5_000);
    expect(analytics?.critical).toBe(false);
  });

  it('should replace a redeclared block rather than merging into it', () => {
    // Given a root block with two keys and a connection that names the block
    const options: JetstreamModuleOptions = {
      name: 'orders',
      events: { concurrency: 4, ackExtension: { enabled: false } },
      connections: {
        primary: { servers: ['nats://a:4222'] },
        analytics: { servers: ['nats://b:4222'], events: { concurrency: 16 } },
      },
      defaultConnection: 'primary',
    };

    // When normalized
    const sut = normalizeOptions(options);
    const analytics = sut.connections.find((c) => c.connectionName === 'analytics');

    // Then the sibling key is gone: the merge is one level deep, and this is the
    // documented behaviour rather than an accident
    expect(analytics?.events).toEqual({ concurrency: 16 });
    expect(analytics?.events?.ackExtension).toBeUndefined();
  });

  it('should default to the connection named "default" when defaultConnection is omitted', () => {
    // Given a connections map that contains a "default" key
    const options: JetstreamModuleOptions = {
      name: 'orders',
      connections: {
        default: { servers: ['nats://a:4222'] },
        analytics: { servers: ['nats://b:4222'] },
      },
    };

    // When normalized
    const sut = normalizeOptions(options);

    // Then that key is the default
    expect(sut.defaultConnection).toBe('default');
  });

  it('should reject supplying both servers and connections', () => {
    // Given both forms at once
    const options: JetstreamModuleOptions = {
      name: 'orders',
      servers: ['nats://a:4222'],
      connections: { analytics: { servers: ['nats://b:4222'] } },
    };

    // When normalized, Then it fails fast
    expect(() => normalizeOptions(options)).toThrow(/exactly one of `servers` or `connections`/);
  });

  it('should reject supplying neither servers nor connections', () => {
    // Given no transport target at all
    const options = { name: 'orders' } as JetstreamModuleOptions;

    // When normalized, Then it fails fast
    expect(() => normalizeOptions(options)).toThrow(/exactly one of `servers` or `connections`/);
  });

  it('should reject an unknown defaultConnection', () => {
    // Given a default that is not among the keys
    const options: JetstreamModuleOptions = {
      name: 'orders',
      connections: { primary: { servers: ['nats://a:4222'] } },
      defaultConnection: 'typo',
    };

    // When normalized, Then it names the known connections
    expect(() => normalizeOptions(options)).toThrow(/defaultConnection "typo"/);
  });

  it('should require defaultConnection when no connection is named "default"', () => {
    // Given several connections and no way to pick one
    const options: JetstreamModuleOptions = {
      name: 'orders',
      connections: {
        primary: { servers: ['nats://a:4222'] },
        analytics: { servers: ['nats://b:4222'] },
      },
    };

    // When normalized, Then it demands an explicit choice
    expect(() => normalizeOptions(options)).toThrow(/defaultConnection is required/);
  });

  it('should reject a name with surrounding whitespace', () => {
    // Given a key that looks like "primary" but is not: the decorator would
    // spell it trimmed and bind nowhere
    const options: JetstreamModuleOptions = {
      name: 'orders',
      connections: { ' primary ': { servers: ['nats://a:4222'] } },
      defaultConnection: ' primary ',
    };

    // When normalized, Then it fails fast
    expect(() => normalizeOptions(options)).toThrow(/surrounding whitespace/);
  });

  it('should reject an empty connections map', () => {
    // Given an empty map
    const options: JetstreamModuleOptions = { name: 'orders', connections: {} };

    // When normalized, Then it fails fast
    expect(() => normalizeOptions(options)).toThrow(/at least one connection/);
  });

  it('should reject two connections pointing at an identical server set', () => {
    // Given the same cluster reachable under two names, port and order normalized
    const options: JetstreamModuleOptions = {
      name: 'orders',
      connections: {
        primary: { servers: ['nats://a:4222', 'nats://b:4222'] },
        clone: { servers: ['nats://b', 'nats://a:4222'] },
      },
      defaultConnection: 'primary',
    };

    // When normalized, Then both names appear in the error
    expect(() => normalizeOptions(options)).toThrow(
      /"primary"[\s\S]*"clone"|"clone"[\s\S]*"primary"/,
    );
  });

  it('should allow a publisher-only connection to share a cluster with a consumer', () => {
    // Given a consumer and a publish-only connection on the same cluster: the
    // latter provisions nothing, so there is no stream to collide over
    const options: JetstreamModuleOptions = {
      name: 'orders',
      connections: {
        primary: { servers: ['nats://a:4222'] },
        audit: { servers: ['nats://a:4222'], consumer: false },
      },
      defaultConnection: 'primary',
    };

    // When normalized, Then it is accepted
    expect(() => normalizeOptions(options)).not.toThrow();
  });

  it('should still reject two consumer connections sharing a cluster', () => {
    // Given two connections that both provision streams on one cluster
    const options: JetstreamModuleOptions = {
      name: 'orders',
      connections: {
        primary: { servers: ['nats://a:4222'] },
        clone: { servers: ['nats://a:4222'] },
      },
      defaultConnection: 'primary',
    };

    // When normalized, Then the collision is caught
    expect(() => normalizeOptions(options)).toThrow(/same NATS cluster/);
  });

  it('should reject a connection with an empty servers list', () => {
    // Given a connection with nothing to connect to
    const options: JetstreamModuleOptions = {
      name: 'orders',
      connections: { primary: { servers: [] } },
      defaultConnection: 'primary',
    };

    // When normalized, Then it fails fast
    expect(() => normalizeOptions(options)).toThrow(/"primary"[\s\S]*at least one server/);
  });
});
