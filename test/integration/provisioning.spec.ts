import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller } from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';
import type { StartedTestContainer } from 'testcontainers';

import { JetstreamProvisioningError } from '../../src';

import { createTestApp, uniqueServiceName } from './helpers';
import { startNatsContainerWithFileStoreLimit } from './nats-container';

@Controller()
class ProvisioningController {
  @EventPattern('order.created')
  handleOrder(): void {}
}

describe('Provisioning error clarity', () => {
  let container: StartedTestContainer;
  let port: number;

  beforeAll(async () => {
    // 1 MiB file store — far below the 5 GiB default event-stream max_bytes
    ({ container, port } = await startNatsContainerWithFileStoreLimit(1024 * 1024));
  });

  afterAll(async () => {
    await container.stop();
  });

  it('should throw a JetstreamProvisioningError (not a raw crash) on insufficient storage', async () => {
    // Given: a service whose default streams exceed max_file_store
    const serviceName = uniqueServiceName();

    // When / Then: app boot fails with the wrapped, actionable error
    let captured: unknown;

    try {
      const { app } = await createTestApp({ name: serviceName, port }, [ProvisioningController]);

      await app.close();
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(JetstreamProvisioningError);

    const provisioningErr = captured as JetstreamProvisioningError;

    expect(provisioningErr.entity).toBe('stream');
    expect(provisioningErr.message).toContain('max_file_store');
    // Pin the real insufficient-storage err_code for NatsErrorCode.InsufficientResources
    expect(provisioningErr.errCode).toBe(10047);
  });
});
