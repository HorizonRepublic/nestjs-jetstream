import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { Logger } from '@nestjs/common';
import { RetentionPolicy, StorageType } from '@nats-io/jetstream';

import { StreamKind } from '../../../interfaces';
import { assertStorageBudget } from '../provisioning-budget';
import { type StreamReservation } from '../provisioning-summary';

const GIB = 1024 ** 3;

const reservation = (
  numReplicas: number,
  maxBytes: number,
  storage: StorageType = StorageType.File,
): StreamReservation => ({
  kind: StreamKind.Event,
  name: 'svc__microservice_ev-stream',
  storage,
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
    // Given: account limit 10 GiB, 6 already reserved; this service wants 5x1 = 5 GiB
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

    // When: 2x3 = 6 GiB needed, only 1 GiB remains in R3
    await assertStorageBudget(jsm as never, 'svc', [reservation(3, 2 * GIB)], logger);

    // Then
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tier R3'));
  });

  it('should warn only for the over-budget replica tier in a mixed-tier service', async () => {
    // Given: R1 ample (top-level), R3 tier tight
    const jsm = createMock({
      getAccountInfo: vi.fn().mockResolvedValue(
        accountInfo({
          reserved_storage: 0,
          limits: { max_storage: 100 * GIB },
          tiers: {
            R3: { reserved_storage: 9 * GIB, limits: { max_storage: 10 * GIB } },
          },
        }),
      ),
    });
    const logger = createMock<Logger>();

    // When: R1 1x1 = 1 GiB (fits), R3 2x3 = 6 GiB (only 1 GiB remains in R3)
    await assertStorageBudget(
      jsm as never,
      'svc',
      [reservation(1, 1 * GIB), reservation(3, 2 * GIB)],
      logger,
    );

    // Then: warns for R3 only, not for R1
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tier R3'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('likely fail'));
  });

  it('should ignore memory-backed reservations when the file budget is ample', async () => {
    // Given: tiny file budget headroom but the huge reservation is memory-backed
    const jsm = createMock({
      getAccountInfo: vi
        .fn()
        .mockResolvedValue(
          accountInfo({ reserved_storage: 1 * GIB, limits: { max_storage: 10 * GIB } }),
        ),
    });
    const logger = createMock<Logger>();

    // When: 100 GiB memory stream, must not count against file storage
    await assertStorageBudget(
      jsm as never,
      'svc',
      [reservation(1, 100 * GIB, StorageType.Memory)],
      logger,
    );

    // Then
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should not throw when account info has no limits shape', async () => {
    // Given: an empty/partial account object (no limits/tiers)
    const jsm = createMock({
      getAccountInfo: vi.fn().mockResolvedValue({}),
    });
    const logger = createMock<Logger>();

    // When / Then: never-throws guard; resolves undefined, treats missing limit as unset
    await expect(
      assertStorageBudget(jsm as never, 'svc', [reservation(1, 5 * GIB)], logger),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('limit not set'));
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
