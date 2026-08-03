import type { MessageHandler } from '@nestjs/microservices';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionProvider } from '../../connection/connection.provider';
import type { ConnectionBinding } from '../../connection/connection.types';
import type { JetstreamModuleOptions } from '../../interfaces';
import { JetstreamStrategy } from '../strategy';

const binding = (overrides: Partial<ConnectionBinding> = {}): ConnectionBinding => ({
  name: 'primary',
  defaultName: 'primary',
  known: new Set(['primary', 'analytics']),
  publisherOnly: new Set<string>(),
  ...overrides,
});

const createSut = (b: ConnectionBinding): JetstreamStrategy =>
  new JetstreamStrategy(
    createMock<JetstreamModuleOptions>({ name: 'orders' }),
    createMock<ConnectionProvider>(),
    createMock(),
    createMock(),
    createMock(),
    createMock(),
    createMock(),
    createMock(),
    createMock(),
    new Map(),
    undefined,
    b,
  );

const handler = (): MessageHandler => createMock<MessageHandler>();

describe('JetstreamStrategy connection binding', () => {
  afterEach(vi.resetAllMocks);

  it('should keep a handler with no connection when it owns the default', () => {
    // Given the strategy for the default connection
    const sut = createSut(binding());

    // When an unqualified handler is registered
    sut.addHandler('order.created', handler(), true, {});

    // Then it is kept
    expect(sut.getHandlers().has('order.created')).toBe(true);
  });

  it('should drop a handler bound to another connection', () => {
    // Given the strategy for "primary"
    const sut = createSut(binding());

    // When a handler bound to "analytics" is registered
    sut.addHandler('order.created', handler(), true, { connection: 'analytics' });

    // Then it is ignored
    expect(sut.getHandlers().has('order.created')).toBe(false);
  });

  it('should keep a handler explicitly bound to itself', () => {
    // Given the strategy for "analytics"
    const sut = createSut(binding({ name: 'analytics' }));

    // When a matching handler is registered
    sut.addHandler('order.created', handler(), true, { connection: 'analytics' });

    // Then it is kept
    expect(sut.getHandlers().has('order.created')).toBe(true);
  });

  it('should drop an unqualified handler when it does not own the default', () => {
    // Given a non-default strategy
    const sut = createSut(binding({ name: 'analytics' }));

    // When an unqualified handler is registered
    sut.addHandler('order.created', handler(), true, {});

    // Then the default connection's strategy takes it, not this one
    expect(sut.getHandlers().has('order.created')).toBe(false);
  });

  it('should still reject a duplicate pattern within one connection', () => {
    // Given a handler already registered
    const sut = createSut(binding());

    sut.addHandler('order.created', handler(), true, {});

    // When the same pattern is registered again
    // Then it fails fast
    expect(() => {
      sut.addHandler('order.created', handler(), true, {});
    }).toThrow(/Duplicate handler/);
  });

  it('should allow the same pattern on two different connections', () => {
    // Given two strategies for two connections
    const primary = createSut(binding());
    const analytics = createSut(binding({ name: 'analytics' }));

    // When the same pattern is registered against each
    primary.addHandler('order.created', handler(), true, { connection: 'primary' });
    analytics.addHandler('order.created', handler(), true, { connection: 'analytics' });

    // Then both keep it — a legitimate migration scenario
    expect(primary.getHandlers().has('order.created')).toBe(true);
    expect(analytics.getHandlers().has('order.created')).toBe(true);
  });

  it('should throw on an unknown connection name', () => {
    // Given a typo in the extras
    const sut = createSut(binding());

    // When the handler is registered
    // Then the error lists the configured names
    expect(() => {
      sut.addHandler('order.created', handler(), true, { connection: 'analitycs' });
    }).toThrow(/Unknown connection "analitycs"[\s\S]*primary[\s\S]*analytics/);
  });

  it('should throw when the target connection is publisher-only', () => {
    // Given a connection configured with consumer: false
    const sut = createSut(binding({ publisherOnly: new Set(['analytics']) }));

    // When a handler targets it
    // Then the error explains why it cannot host handlers
    expect(() => {
      sut.addHandler('order.created', handler(), true, { connection: 'analytics' });
    }).toThrow(/publisher-only/);
  });
});
