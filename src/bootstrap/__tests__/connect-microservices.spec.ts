import type { INestApplication } from '@nestjs/common';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionRegistry } from '../../connection/connection-registry';
import type { ConnectionScope } from '../../connection/connection.types';
import { JETSTREAM_CONNECTIONS } from '../../jetstream.constants';
import { connectJetstreamMicroservices } from '../connect-microservices';

const scope = (name: string, withStrategy: boolean): ConnectionScope =>
  createMock<ConnectionScope>({
    name,
    strategy: withStrategy ? createMock() : null,
  });

const appWith = (registry: ConnectionRegistry): INestApplication =>
  createMock<INestApplication>({ get: vi.fn().mockReturnValue(registry) });

describe('connectJetstreamMicroservices', () => {
  afterEach(vi.resetAllMocks);

  it('should connect one microservice per consumer connection', () => {
    // Given two consumer connections
    const registry = new ConnectionRegistry(
      new Map([
        ['primary', scope('primary', true)],
        ['analytics', scope('analytics', true)],
      ]),
      'primary',
    );
    const sut = appWith(registry);

    // When the helper runs
    connectJetstreamMicroservices(sut);

    // Then each strategy is attached
    expect(sut.connectMicroservice).toHaveBeenCalledTimes(2);
    expect(sut.get).toHaveBeenCalledWith(JETSTREAM_CONNECTIONS, { strict: false });
  });

  it('should skip publisher-only connections', () => {
    // Given one consumer and one publisher-only connection
    const registry = new ConnectionRegistry(
      new Map([
        ['primary', scope('primary', true)],
        ['analytics', scope('analytics', false)],
      ]),
      'primary',
    );
    const sut = appWith(registry);

    // When the helper runs
    connectJetstreamMicroservices(sut);

    // Then only the consumer connection is attached
    expect(sut.connectMicroservice).toHaveBeenCalledTimes(1);
  });

  it('should forward hybrid options to every microservice', () => {
    // Given hybrid options
    const registry = new ConnectionRegistry(
      new Map([['primary', scope('primary', true)]]),
      'primary',
    );
    const sut = appWith(registry);

    // When the helper runs with inheritAppConfig
    connectJetstreamMicroservices(sut, { hybridOptions: { inheritAppConfig: true } });

    // Then they reach connectMicroservice
    expect(sut.connectMicroservice).toHaveBeenCalledWith(expect.anything(), {
      inheritAppConfig: true,
    });
  });
});
