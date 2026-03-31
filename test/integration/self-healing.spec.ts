import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { NatsConnection } from 'nats';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { getClientToken } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import {
  restartNatsContainer,
  startNatsContainer,
  startNatsContainerWithFixedPort,
} from './nats-container';

// Fixed port for the reconnect test — must survive container.restart()
const RECONNECT_TEST_PORT = 14_222;

// ---------------------------------------------------------------------------
// Test Controllers
// ---------------------------------------------------------------------------

@Controller()
class SelfHealingController {
  public readonly received: unknown[] = [];

  @EventPattern('healing.check')
  handleEvent(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

@Controller()
class DestroyRestartController {
  public readonly received: unknown[] = [];

  @EventPattern('lifecycle.check')
  handleEvent(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Self-Healing Consumer Flow', () => {
  describe('event consumer reconnect after NATS restart', () => {
    let container: StartedTestContainer;
    let port: number;
    let nc: NatsConnection;
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: SelfHealingController;

    beforeAll(async () => {
      // Fixed port binding ensures the port survives container.restart()
      ({ container, port } = await startNatsContainerWithFixedPort(RECONNECT_TEST_PORT));
    });

    afterAll(async () => {
      await container.stop();
    });

    beforeEach(async () => {
      nc = await createNatsConnection(port);
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName, port },
        [SelfHealingController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
      controller = module.get(SelfHealingController);
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName).catch(() => {});
      await nc.drain().catch(() => {});
    });

    it('should recover consumer after NATS container restart', { timeout: 60_000 }, async () => {
      // Given: event is delivered before restart
      await firstValueFrom(client.emit('healing.check', { seq: 1 }));

      await waitForCondition(() => controller.received.length >= 1, 5_000);

      expect(controller.received[0]).toEqual({ seq: 1 });

      // When: NATS container restarts (simulates network partition / server crash)
      await restartNatsContainer(container);

      // The test's own NATS connection is broken by the restart — recreate it
      await nc.drain().catch(() => {});
      nc = await createNatsConnection(port);

      // Then: retry sending until the client's internal connection auto-reconnects
      const deadline = Date.now() + 20_000;
      let sent = false;

      while (Date.now() < deadline) {
        try {
          await firstValueFrom(client.emit('healing.check', { seq: 2 }));
          sent = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      expect(sent).toBe(true);

      // Verify the self-healing flow re-established the consumer and delivered the event
      await waitForCondition(() => controller.received.length >= 2, 20_000);

      expect(controller.received[1]).toEqual({ seq: 2 });
    });
  });

  describe('destroy and restart lifecycle', () => {
    let container: StartedTestContainer;
    let port: number;
    let nc: NatsConnection;
    let serviceName: string;

    beforeAll(async () => {
      ({ container, port } = await startNatsContainer());
      nc = await createNatsConnection(port);
    });

    afterAll(async () => {
      await nc.drain();
      await container.stop();
    });

    beforeEach(() => {
      serviceName = uniqueServiceName();
    });

    afterEach(async () => {
      await cleanupStreams(nc, serviceName);
    });

    it('should deliver events after destroy and restart with a new app', { timeout: 30_000 }, async () => {
      // Given: first app starts and processes an event
      const { app: firstApp, module: firstModule } = await createTestApp(
        { name: serviceName, port },
        [DestroyRestartController],
        [serviceName],
      );

      const firstClient = firstModule.get<ClientProxy>(getClientToken(serviceName));
      const firstController = firstModule.get(DestroyRestartController);

      await firstValueFrom(firstClient.emit('lifecycle.check', { phase: 'before-restart' }));

      await waitForCondition(() => firstController.received.length >= 1, 5_000);

      expect(firstController.received[0]).toEqual({ phase: 'before-restart' });

      // When: first app is destroyed (triggers destroy() which reinitializes subjects)
      await firstApp.close();

      // Then: a new app with the same service name starts and receives events
      const { app: secondApp, module: secondModule } = await createTestApp(
        { name: serviceName, port },
        [DestroyRestartController],
        [serviceName],
      );

      const secondClient = secondModule.get<ClientProxy>(getClientToken(serviceName));
      const secondController = secondModule.get(DestroyRestartController);

      await firstValueFrom(secondClient.emit('lifecycle.check', { phase: 'after-restart' }));

      await waitForCondition(() => secondController.received.length >= 1, 5_000);

      expect(secondController.received[0]).toEqual({ phase: 'after-restart' });

      await secondApp.close();
    });
  });
});
