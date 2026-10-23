import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionProvider } from '../../src/connection/connection.provider';
import { NatsCapability } from '../../src/connection/server-capabilities.types';
import { EventBus } from '../../src/hooks';
import { startNatsContainer } from './nats-container';

describe('Server capabilities', () => {
  afterEach(vi.resetAllMocks);

  it.each([
    ['nats:2.12.6', 3, false],
    ['nats:2.15.1', 5, true],
  ])('should read the API level of %s', async (image, level, recurring) => {
    // Given
    const { container, port } = await startNatsContainer(image);
    const sut = new ConnectionProvider(
      { name: faker.lorem.word(), servers: [`nats://localhost:${port}`] },
      createMock<EventBus>(),
    );

    try {
      // When
      const capabilities = await sut.getCapabilities();

      // Then
      expect(capabilities.apiLevel).toBe(level);
      expect(capabilities.supports(NatsCapability.RecurringSchedules)).toBe(recurring);
    } finally {
      try {
        await sut.shutdown();
      } finally {
        await container.stop();
      }
    }
  });
});
