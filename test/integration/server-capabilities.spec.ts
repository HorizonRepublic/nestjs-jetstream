import { Controller } from '@nestjs/common';
import { ClientProxy, EventPattern } from '@nestjs/microservices';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getClientToken, JetstreamCapabilityError, JetstreamRecordBuilder } from '../../src';
import { ConnectionProvider } from '../../src/connection/connection.provider';
import { NatsCapability } from '../../src/connection/server-capabilities.types';
import { EventBus } from '../../src/hooks';
import { createTestApp, uniqueServiceName } from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class EventsController {
  @EventPattern<string>('order.created')
  created(): void {}
}

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

describe('Server capability gates on real servers', () => {
  it('should refuse to provision message TTL on NATS 2.10, which ignores it', async () => {
    // Given
    const { container, port } = await startNatsContainer('nats:2.10');

    try {
      // When / Then
      await expect(
        createTestApp(
          { name: uniqueServiceName(), port, events: { stream: { allow_msg_ttl: true } } },
          [EventsController],
        ),
      ).rejects.toThrow(/allow_msg_ttl\) needs NATS JetStream API level 1 \(NATS 2\.11/);
    } finally {
      await container.stop();
    }
  });

  it('should refuse scheduleAt() on NATS 2.11, which stores the holder and never fires it', async () => {
    // Given
    const { container, port } = await startNatsContainer('nats:2.11.0');
    const service = uniqueServiceName();

    try {
      const { app } = await createTestApp({ name: service, port }, [EventsController], [service]);
      const client = app.get<ClientProxy>(getClientToken(service));
      const record = new JetstreamRecordBuilder({})
        .scheduleAt(new Date(Date.now() + 60_000))
        .build();

      // When / Then
      await expect(firstValueFrom(client.emit('order.created', record))).rejects.toThrow(
        JetstreamCapabilityError,
      );
      await app.close();
    } finally {
      await container.stop();
    }
  });
});
