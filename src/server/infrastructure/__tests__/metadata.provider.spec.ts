import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';

import { ConnectionProvider } from '../../../connection';
import type { JetstreamModuleOptions } from '../../../interfaces';
import {
  DEFAULT_METADATA_BUCKET,
  DEFAULT_METADATA_HISTORY,
  DEFAULT_METADATA_REPLICAS,
} from '../../../jetstream.constants';

import { MetadataProvider } from '../metadata.provider';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPut = vi.fn<(k: string, data: string) => Promise<number>>();
const mockDelete = vi.fn<(k: string) => Promise<void>>();

const mockKv = { put: mockPut, delete: mockDelete };
const mockCreate = vi.fn<(name: string, opts?: unknown) => Promise<typeof mockKv>>();

vi.mock('@nats-io/kv', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const KvmImpl = function KvmImpl() {
    // @ts-expect-error -- mock constructor
    this.create = mockCreate;
  };

  return { Kvm: KvmImpl };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(MetadataProvider, () => {
  let sut: MetadataProvider;
  let connection: ConnectionProvider;
  let options: JetstreamModuleOptions;

  beforeEach(() => {
    mockCreate.mockResolvedValue(mockKv);
    mockPut.mockResolvedValue(1);
    mockDelete.mockResolvedValue(undefined);

    options = {
      name: faker.lorem.word(),
      servers: ['nats://localhost:4222'],
    };

    connection = createMock<ConnectionProvider>({
      getJetStreamClient: vi.fn().mockReturnValue({}),
    });

    sut = new MetadataProvider(options, connection);
  });

  afterEach(vi.resetAllMocks);

  describe('publish()', () => {
    describe('happy path', () => {
      it('should write each entry to KV bucket', async () => {
        // Given: metadata entries
        const entries = new Map<string, Record<string, unknown>>([
          [`${options.name}.ev.order.created`, { http: { method: 'POST', path: '/orders' } }],
          [`${options.name}.cmd.order.get`, { http: { method: 'GET', path: '/orders/:id' } }],
        ]);

        // When
        await sut.publish(entries);

        // Then: bucket created with defaults
        expect(mockCreate).toHaveBeenCalledWith(DEFAULT_METADATA_BUCKET, {
          history: DEFAULT_METADATA_HISTORY,
          replicas: DEFAULT_METADATA_REPLICAS,
        });

        // Then: each entry written
        expect(mockPut).toHaveBeenCalledTimes(2);

        expect(mockPut).toHaveBeenCalledWith(
          `${options.name}.ev.order.created`,
          JSON.stringify({ http: { method: 'POST', path: '/orders' } }),
        );

        expect(mockPut).toHaveBeenCalledWith(
          `${options.name}.cmd.order.get`,
          JSON.stringify({ http: { method: 'GET', path: '/orders/:id' } }),
        );
      });

      it('should use custom bucket name and replicas from options', async () => {
        // Given: custom metadata options
        const customBucket = faker.lorem.word();
        const customReplicas = 3;

        options.metadata = { bucket: customBucket, replicas: customReplicas };
        sut = new MetadataProvider(options, connection);

        const entries = new Map<string, Record<string, unknown>>([['key', { value: true }]]);

        // When
        await sut.publish(entries);

        // Then
        expect(mockCreate).toHaveBeenCalledWith(customBucket, {
          history: DEFAULT_METADATA_HISTORY,
          replicas: customReplicas,
        });
      });
    });

    describe('edge cases', () => {
      it('should skip KV operations when entries map is empty', async () => {
        // Given: no entries
        const entries = new Map<string, Record<string, unknown>>();

        // When
        await sut.publish(entries);

        // Then: no KV interaction
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockPut).not.toHaveBeenCalled();
      });
    });

    describe('error paths', () => {
      it('should not throw when KV operations fail', async () => {
        // Given: KV put fails
        mockCreate.mockRejectedValueOnce(new Error('KV unavailable'));

        const entries = new Map<string, Record<string, unknown>>([['key', { value: true }]]);

        // When/Then: does not throw
        await expect(sut.publish(entries)).resolves.toBeUndefined();
      });
    });
  });

  describe('cleanup()', () => {
    describe('happy path', () => {
      it('should delete previously published keys when cleanupOnShutdown is true', async () => {
        // Given: entries were published (default cleanupOnShutdown = true)
        const entries = new Map<string, Record<string, unknown>>([
          ['svc.ev.order.created', { http: { method: 'POST' } }],
          ['svc.cmd.order.get', { http: { method: 'GET' } }],
        ]);

        await sut.publish(entries);
        vi.clearAllMocks();
        mockCreate.mockResolvedValue(mockKv);

        // When
        await sut.cleanup();

        // Then: each key deleted
        expect(mockDelete).toHaveBeenCalledTimes(2);
        expect(mockDelete).toHaveBeenCalledWith('svc.ev.order.created');
        expect(mockDelete).toHaveBeenCalledWith('svc.cmd.order.get');
      });
    });

    describe('edge cases', () => {
      it('should skip cleanup when cleanupOnShutdown is false', async () => {
        // Given: cleanup disabled
        options.metadata = { cleanupOnShutdown: false };
        sut = new MetadataProvider(options, connection);

        const entries = new Map<string, Record<string, unknown>>([['key', { value: true }]]);

        await sut.publish(entries);
        vi.clearAllMocks();

        // When
        await sut.cleanup();

        // Then: no KV interaction
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockDelete).not.toHaveBeenCalled();
      });

      it('should skip cleanup when no entries were published', async () => {
        // Given: nothing was published

        // When
        await sut.cleanup();

        // Then
        expect(mockCreate).not.toHaveBeenCalled();
      });

      it('should clear published keys after successful cleanup', async () => {
        // Given: entries published
        const entries = new Map<string, Record<string, unknown>>([['key', { value: true }]]);

        await sut.publish(entries);
        vi.clearAllMocks();
        mockCreate.mockResolvedValue(mockKv);

        // When: cleanup twice
        await sut.cleanup();
        await sut.cleanup();

        // Then: second cleanup is no-op
        expect(mockDelete).toHaveBeenCalledTimes(1);
      });
    });

    describe('error paths', () => {
      it('should not throw when KV delete fails', async () => {
        // Given: entries published, delete will fail
        const entries = new Map<string, Record<string, unknown>>([['key', { value: true }]]);

        await sut.publish(entries);
        mockDelete.mockRejectedValueOnce(new Error('delete failed'));

        // When/Then: does not throw
        await expect(sut.cleanup()).resolves.toBeUndefined();
      });
    });
  });
});
