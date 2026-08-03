import { Logger } from '@nestjs/common';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonCodec } from '../../codec';
import { EventBus } from '../../hooks';
import type { ResolvedConnectionOptions } from '../../interfaces';
import { createConnectionScope } from '../connection-scope';
import type { ConnectionSharedContext } from '../connection.types';

const shared = (): ConnectionSharedContext => ({
  eventBus: new EventBus(new Logger('test'), undefined),
  rootCodec: new JsonCodec(),
});

const options = (
  overrides: Partial<ResolvedConnectionOptions> = {},
): ResolvedConnectionOptions => ({
  name: 'orders',
  servers: ['nats://localhost:4222'],
  connectionName: 'primary',
  critical: true,
  ...overrides,
});

describe('createConnectionScope', () => {
  afterEach(vi.resetAllMocks);

  it('should build a fully populated scope for a consumer connection', () => {
    // Given a consumer-enabled connection
    // When the scope is created
    const sut = createConnectionScope(options(), shared());

    // Then every component is present
    expect(sut.name).toBe('primary');
    expect(sut.critical).toBe(true);
    expect(sut.connection).toBeDefined();
    expect(sut.names).toBeDefined();
    expect(sut.patterns).not.toBeNull();
    expect(sut.streams).not.toBeNull();
    expect(sut.consumers).not.toBeNull();
    expect(sut.messages).not.toBeNull();
    expect(sut.eventRouter).not.toBeNull();
    expect(sut.rpcRouter).not.toBeNull();
    expect(sut.coreRpc).not.toBeNull();
    expect(sut.metadata).not.toBeNull();
    expect(sut.strategy).not.toBeNull();
  });

  it('should null out consumer infrastructure in publisher-only mode', () => {
    // Given consumer: false
    // When the scope is created
    const sut = createConnectionScope(options({ consumer: false }), shared());

    // Then only the publish path survives
    expect(sut.connection).toBeDefined();
    expect(sut.names).toBeDefined();
    expect(sut.patterns).toBeNull();
    expect(sut.streams).toBeNull();
    expect(sut.strategy).toBeNull();
  });

  it('should fall back to the root codec when the connection sets none', () => {
    // Given a shared context with a known root codec
    const context = shared();

    // When the scope is created without a per-connection codec
    const sut = createConnectionScope(options(), context);

    // Then the root codec is reused
    expect(sut.codec).toBe(context.rootCodec);
  });

  it('should prefer the per-connection codec over the root codec', () => {
    // Given a connection-level codec
    const codec = new JsonCodec();
    const context = shared();

    // When the scope is created
    const sut = createConnectionScope(options({ codec }), context);

    // Then the connection codec wins
    expect(sut.codec).toBe(codec);
    expect(sut.codec).not.toBe(context.rootCodec);
  });
});
