import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { Logger } from '@nestjs/common';
import { RetentionPolicy, StorageType } from '@nats-io/jetstream';

import { assertStorageBudget } from '../provisioning-budget';
import { type StreamReservation } from '../provisioning-summary';

const GIB = 1024 ** 3;

const reservation = (numReplicas: number, maxBytes: number): StreamReservation => ({
  kind: 'ev',
  name: 'svc__microservice_ev-stream',
  storage: StorageType.File,
  numReplicas,
  maxBytes,
  maxAge: 0,
  retention: RetentionPolicy.Workqueue,
});

const accountInfo = (overrides: Record<string, unknown> = {}): unknown => ({
  storage: 0,
  reserved_storage: 0,
  memory: 0,
  reserved_memory: 0,
  streams: 0,
  consumers: 0,
  limits: { max_storage: 0, max_memory: 0 },
  api: { total: 0, errors: 0 },
  ...overrides,
});

describe('assertStorageBudget', () => {
  afterEach(vi.resetAllMocks);

  it('should warn when the reservation exceeds the remaining account budget', async () => {
    // Given: account limit 10 GiB, 6 already reserved; this service wants 5×1 = 5 GiB
    const jsm = createMock({
      getAccountInfo: vi
        .fn()
        .mockResolvedValue(
          accountInfo({ reserved_storage: 6 * GIB, limits: { max_storage: 10 * GIB } }),
        ),
    });
    const logger = createMock<Logger>();

    // When
    await assertStorageBudget(jsm as never, 'svc', [reservation(1, 5 * GIB)], logger);

    // Then
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Provisioning will likely fail'),
    );
  });

  it('should NOT warn (logs OK) when the reservation fits', async () => {
    // Given: 10 GiB limit, 1 reserved; wants 5 GiB
    const jsm = createMock({
      getAccountInfo: vi
        .fn()
        .mockResolvedValue(
          accountInfo({ reserved_storage: 1 * GIB, limits: { max_storage: 10 * GIB } }),
        ),
    });
    const logger = createMock<Logger>();

    // When
    await assertStorageBudget(jsm as never, 'svc', [reservation(1, 5 * GIB)], logger);

    // Then
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalled();
  });

  it('should warn that the limit is unset when max_storage <= 0', async () => {
    // Given: unlimited account (server-side max_file_store not visible)
    const jsm = createMock({
      getAccountInfo: vi.fn().mockResolvedValue(accountInfo({ limits: { max_storage: -1 } })),
    });
    const logger = createMock<Logger>();

    // When
    await assertStorageBudget(jsm as never, 'svc', [reservation(1, 5 * GIB)], logger);

    // Then
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('limit not set'));
  });

  it('should prefer the replication-tier budget when present', async () => {
    // Given: top-level unlimited, but tier R3 has a tight limit
    const jsm = createMock({
      getAccountInfo: vi.fn().mockResolvedValue(
        accountInfo({
          limits: { max_storage: -1 },
          tiers: {
            R3: { reserved_storage: 9 * GIB, limits: { max_storage: 10 * GIB } },
          },
        }),
      ),
    });
    const logger = createMock<Logger>();

    // When: 2×3 = 6 GiB needed, only 1 GiB remains in R3
    await assertStorageBudget(jsm as never, 'svc', [reservation(3, 2 * GIB)], logger);

    // Then
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tier R3'));
  });

  it('should degrade gracefully (no throw) when getAccountInfo fails', async () => {
    // Given
    const jsm = createMock({
      getAccountInfo: vi.fn().mockRejectedValue(new Error('no permission')),
    });
    const logger = createMock<Logger>();

    // When / Then: must not throw, must not warn
    await expect(
      assertStorageBudget(jsm as never, 'svc', [reservation(1, 5 * GIB)], logger),
    ).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });
});
