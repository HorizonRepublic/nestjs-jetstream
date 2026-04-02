import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';

import { ConnectionProvider } from '../../../connection';
import type { JetstreamModuleOptions } from '../../../interfaces';
import {
  DEFAULT_METADATA_BUCKET,
  DEFAULT_METADATA_HISTORY,
  DEFAULT_METADATA_REPLICAS,
  DEFAULT_METADATA_TTL,
} from '../../../jetstream.constants';

import { MetadataProvider } from '../metadata.provider';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPut = vi.fn<(k: string, data: string) => Promise<number>>();

const mockKv = { put: mockPut };
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
    vi.useFakeTimers();

    mockCreate.mockResolvedValue(mockKv);
    mockPut.mockResolvedValue(1);

    options = {
      name: faker.lorem.word(),
      servers: ['nats://localhost:4222'],
    };

    connection = createMock<ConnectionProvider>({
      getJetStreamClient: vi.fn().mockReturnValue({}),
    });

    sut = new MetadataProvider(options, connection);
  });

  afterEach(() => {
    sut.destroy();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe('publish()', () => {
    describe('happy path', () => {
      it('should write each entry to KV bucket with TTL', async () => {
        // Given: metadata entries
        const entries = new Map<string, Record<string, unknown>>([
          [`${options.name}.ev.order.created`, { http: { method: 'POST', path: '/orders' } }],
          [`${options.name}.cmd.order.get`, { http: { method: 'GET', path: '/orders/:id' } }],
        ]);

        // When
        await sut.publish(entries);

        // Then: bucket created with defaults including TTL
        expect(mockCreate).toHaveBeenCalledWith(DEFAULT_METADATA_BUCKET, {
          history: DEFAULT_METADATA_HISTORY,
          replicas: DEFAULT_METADATA_REPLICAS,
          ttl: DEFAULT_METADATA_TTL,
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

      it('should use custom bucket name, replicas, and TTL from options', async () => {
        // Given: custom metadata options
        const customBucket = faker.lorem.word();
        const customReplicas = 3;
        const customTtl = 60_000;

        options.metadata = { bucket: customBucket, replicas: customReplicas, ttl: customTtl };
        sut = new MetadataProvider(options, connection);

        const entries = new Map<string, Record<string, unknown>>([['key', { value: true }]]);

        // When
        await sut.publish(entries);

        // Then
        expect(mockCreate).toHaveBeenCalledWith(customBucket, {
          history: DEFAULT_METADATA_HISTORY,
          replicas: customReplicas,
          ttl: customTtl,
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
      it('should not throw when bucket creation fails', async () => {
        // Given: KV bucket creation fails
        mockCreate.mockRejectedValueOnce(new Error('KV unavailable'));

        const entries = new Map<string, Record<string, unknown>>([['key', { value: true }]]);

        // When/Then: does not throw
        await expect(sut.publish(entries)).resolves.toBeUndefined();
      });

      it('should continue writing remaining entries when one put fails', async () => {
        // Given: first put fails, second succeeds
        mockPut.mockRejectedValueOnce(new Error('put failed')).mockResolvedValueOnce(1);

        const entries = new Map<string, Record<string, unknown>>([
          ['key1', { a: 1 }],
          ['key2', { b: 2 }],
        ]);

        // When
        await sut.publish(entries);

        // Then: both puts attempted
        expect(mockPut).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('heartbeat', () => {
    it('should refresh entries at half the TTL interval', async () => {
      // Given: published entries with default TTL (30s → heartbeat every 15s)
      const entries = new Map<string, Record<string, unknown>>([['key', { v: 1 }]]);

      await sut.publish(entries);
      mockPut.mockClear();

      // When: advance time by one heartbeat interval (TTL/2 = 15s)
      await vi.advanceTimersByTimeAsync(DEFAULT_METADATA_TTL / 2);

      // Then: entries refreshed
      expect(mockPut).toHaveBeenCalledWith('key', JSON.stringify({ v: 1 }));
    });

    it('should not refresh after destroy', async () => {
      // Given: published and then destroyed
      const entries = new Map<string, Record<string, unknown>>([['key', { v: 1 }]]);

      await sut.publish(entries);
      sut.destroy();
      mockPut.mockClear();

      // When: advance past heartbeat interval
      await vi.advanceTimersByTimeAsync(DEFAULT_METADATA_TTL);

      // Then: no refresh
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('should not throw when heartbeat refresh fails', async () => {
      // Given: published, then KV becomes unavailable
      const entries = new Map<string, Record<string, unknown>>([['key', { v: 1 }]]);

      await sut.publish(entries);
      mockCreate.mockRejectedValue(new Error('connection lost'));

      // When: heartbeat tick fires
      await vi.advanceTimersByTimeAsync(DEFAULT_METADATA_TTL / 2);

      // Then: refresh was attempted (mockCreate called) but didn't crash
      expect(mockCreate).toHaveBeenCalled();
    });
  });

  describe('destroy()', () => {
    it('should be safe to call multiple times', () => {
      // When: double destroy
      sut.destroy();
      sut.destroy();

      // Then: no error thrown (implicit — test completes)
      expect(true).toBe(true);
    });
  });
});
