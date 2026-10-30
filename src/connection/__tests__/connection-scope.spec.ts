import { Logger } from '@nestjs/common';

import type { ConsumerInfo, JetStreamManager } from '@nats-io/jetstream';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonCodec } from '../../codec';
import { EventBus } from '../../hooks';
import { StreamKind } from '../../interfaces';
import type { ResolvedConnectionOptions } from '../../interfaces';
import { ConsumerProvider, type ConsumerRecoveryFn } from '../../server/infrastructure';
import { createConnectionScope } from '../connection-scope';
import { ConnectionProvider } from '../connection.provider';
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
  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('should refresh ack_wait and max_deliver from a recovered consumer', async () => {
    // Given: a recovered consumer that came back with another config
    const recovered = createMock<ConsumerInfo>({
      stream_name: faker.lorem.word(),
      config: {
        ack_wait: faker.number.int({ min: 1_000_000 }),
        max_deliver: faker.number.int({ min: 1, max: 20 }),
      },
    });
    const lastKnown = createMock<ConsumerInfo>();

    vi.spyOn(ConnectionProvider.prototype, 'getJetStreamManager').mockResolvedValue(
      createMock<JetStreamManager>(),
    );

    const recover = vi
      .spyOn(ConsumerProvider.prototype, 'recoverConsumer')
      .mockResolvedValue(recovered);
    const sut = createConnectionScope(options(), shared());
    const refreshMaxDeliver = vi.spyOn(sut.eventRouter!, 'refreshMaxDeliver');
    const recoveryFn = Reflect.get(sut.messages!, 'consumerRecoveryFn') as ConsumerRecoveryFn;

    // When
    const result = await recoveryFn(StreamKind.Event, lastKnown);

    // Then
    expect(result).toBe(recovered);
    expect(recover).toHaveBeenCalledWith(expect.anything(), StreamKind.Event, lastKnown);
    expect(sut.ackWaitMap.get(StreamKind.Event)).toBe(recovered.config.ack_wait);
    expect(refreshMaxDeliver).toHaveBeenCalledWith(recovered);
  });

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
    // Given publisherOnly: true
    // When the scope is created
    const sut = createConnectionScope(options({ publisherOnly: true }), shared());

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
