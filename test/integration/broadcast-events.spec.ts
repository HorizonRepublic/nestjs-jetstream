import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { NatsConnection } from 'nats';
import { firstValueFrom } from 'rxjs';

import { getClientToken } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';

// ---------------------------------------------------------------------------
// Test Controllers (one per "service")
// ---------------------------------------------------------------------------

@Controller()
class BroadcastControllerA {
  public readonly received: unknown[] = [];

  @EventPattern('config.updated', { broadcast: true })
  handleConfig(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

@Controller()
class BroadcastControllerB {
  public readonly received: unknown[] = [];

  @EventPattern('config.updated', { broadcast: true })
  handleConfig(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Broadcast Event Delivery', () => {
  let nc: NatsConnection;

  beforeAll(async () => {
    nc = await createNatsConnection();
  });

  afterAll(async () => {
    await nc.drain();
  });

  describe('fan-out to multiple services', () => {
    let appA: INestApplication;
    let moduleA: TestingModule;
    let appB: INestApplication;
    let moduleB: TestingModule;
    let clientA: ClientProxy;
    let controllerA: BroadcastControllerA;
    let controllerB: BroadcastControllerB;
    let serviceA: string;
    let serviceB: string;

    beforeEach(async () => {
      serviceA = uniqueServiceName();
      serviceB = uniqueServiceName();

      // Two independent services sharing the broadcast stream
      ({ app: appA, module: moduleA } = await createTestApp(
        { name: serviceA },
        [BroadcastControllerA],
        [serviceA],
      ));

      ({ app: appB, module: moduleB } = await createTestApp(
        { name: serviceB },
        [BroadcastControllerB],
        [serviceB],
      ));

      clientA = moduleA.get<ClientProxy>(getClientToken(serviceA));
      controllerA = moduleA.get(BroadcastControllerA);
      controllerB = moduleB.get(BroadcastControllerB);
    });

    afterEach(async () => {
      await appA.close();
      await appB.close();
      await cleanupStreams(nc, serviceA);
      await cleanupStreams(nc, serviceB);
    });

    it('should deliver broadcast event to ALL subscribing services', async () => {
      await firstValueFrom(
        clientA.emit('broadcast:config.updated', { key: 'theme', value: 'dark' }),
      );

      await waitForCondition(
        () => controllerA.received.length > 0 && controllerB.received.length > 0,
        5_000,
      );

      expect(controllerA.received[0]).toEqual({ key: 'theme', value: 'dark' });
      expect(controllerB.received[0]).toEqual({ key: 'theme', value: 'dark' });
    });

    it('should deliver multiple broadcast events to both services', async () => {
      for (let i = 0; i < 3; i++) {
        await firstValueFrom(clientA.emit('broadcast:config.updated', { seq: i }));
      }

      await waitForCondition(
        () => controllerA.received.length === 3 && controllerB.received.length === 3,
        10_000,
      );

      expect(controllerA.received).toEqual([{ seq: 0 }, { seq: 1 }, { seq: 2 }]);
      expect(controllerB.received).toEqual([{ seq: 0 }, { seq: 1 }, { seq: 2 }]);
    });
  });
});
