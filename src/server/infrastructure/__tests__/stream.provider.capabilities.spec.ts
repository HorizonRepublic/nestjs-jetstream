import type { StreamInfo } from '@nats-io/jetstream';
import { JetStreamApiError } from '@nats-io/jetstream';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { ConnectionProvider } from '../../../connection';
import {
  JetstreamCapabilityError,
  ServerCapabilities,
} from '../../../connection/server-capabilities';
import { StreamKind } from '../../../interfaces';
import type { JetstreamModuleOptions } from '../../../interfaces';
import { PatternRegistry } from '../../routing';
import { InfrastructureBinder } from '../infrastructure-binder';
import { NameResolver } from '../name-resolver';
import { StreamProvider } from '../stream.provider';

describe('StreamProvider server capabilities', () => {
  let options: JetstreamModuleOptions;
  let level: number;
  let mockJsm: { streams: Record<'info' | 'add' | 'update', ReturnType<typeof vi.fn>> };
  let connection: Mocked<ConnectionProvider>;

  const makeSut = (): StreamProvider => {
    const names = new NameResolver(options);

    return new StreamProvider(
      options,
      connection,
      names,
      new InfrastructureBinder(options, names, createMock<PatternRegistry>()),
    );
  };

  beforeEach(() => {
    level = 0;
    options = { name: faker.lorem.word(), servers: ['nats://localhost:4222'], dlq: false };
    mockJsm = {
      streams: {
        info: vi
          .fn()
          .mockRejectedValue(
            new JetStreamApiError({ err_code: 10059, code: 404, description: 'stream not found' }),
          ),
        add: vi.fn().mockResolvedValue(createMock<StreamInfo>()),
        update: vi.fn(),
      },
    };
    connection = createMock<ConnectionProvider>({
      getJetStreamManager: vi.fn().mockResolvedValue(mockJsm),
      getCapabilities: vi.fn(async () => new ServerCapabilities(level, 'n1 (NATS 2.10.29)')),
    });
  });

  afterEach(vi.resetAllMocks);

  it('should not ask the server when no stream needs a gated feature', async () => {
    // When
    await makeSut().ensureStreams([StreamKind.Event]);

    // Then
    expect(connection.getCapabilities).not.toHaveBeenCalled();
    expect(mockJsm.streams.add).toHaveBeenCalled();
  });

  it('should refuse message TTL on a server that ignores it, before creating anything', async () => {
    // Given
    options.events = { stream: { allow_msg_ttl: true } };

    // When / Then
    await expect(makeSut().ensureStreams([StreamKind.Event])).rejects.toThrow(
      JetstreamCapabilityError,
    );
    await expect(makeSut().ensureStreams([StreamKind.Event])).rejects.toThrow(
      /allow_msg_ttl.*NATS 2\.11/,
    );
    expect(mockJsm.streams.add).not.toHaveBeenCalled();
  });

  it('should refuse message schedules on a server older than 2.12', async () => {
    // Given
    level = 1;
    options.broadcast = { stream: { allow_msg_schedules: true } };

    // When / Then
    await expect(makeSut().ensureStreams([StreamKind.Broadcast])).rejects.toThrow(
      /allow_msg_schedules.*NATS 2\.12/,
    );
  });

  it('should require message schedules for the schedule stream', async () => {
    // Given
    level = 1;

    // When / Then
    await expect(makeSut().ensureStreams([StreamKind.Schedule])).rejects.toThrow(
      /allow_msg_schedules/,
    );
  });

  it('should provision gated features on a server that has them', async () => {
    // Given
    level = 4;
    options.events = { stream: { allow_msg_ttl: true, allow_msg_schedules: true } };

    // When
    await makeSut().ensureStreams([StreamKind.Event, StreamKind.Schedule]);

    // Then
    expect(mockJsm.streams.add).toHaveBeenCalledTimes(2);
  });
});
