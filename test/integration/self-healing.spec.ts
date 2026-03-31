import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { NatsConnection } from 'nats';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { consumerName, getClientToken, StreamKind, streamName } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

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
  describe('consumer recovery after deletion', () => {
    let container: StartedTestContainer;
    let port: number;
    let nc: NatsConnection;
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: SelfHealingController;

    beforeAll(async () => {
      ({ container, port } = await startNatsContainer());
    });

    afterAll(async () => {
      await container.stop();
    });

    beforeEach(async () => {
      nc = await createNatsConnection(port);
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          // Short heartbeat so consumer deletion is detected faster in tests
          events: { consume: { idle_heartbeat: 1_000 } },
        },
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

    it(
      'should recover consumption after consumer is deleted and re-created',
      { timeout: 30_000 },
      async () => {
        // Given: event is delivered successfully
        await firstValueFrom(client.emit('healing.check', { seq: 1 }));

        await waitForCondition(() => controller.received.length >= 1, 5_000);

        expect(controller.received[0]).toEqual({ seq: 1 });

        // When: delete the consumer via JetStream Management API
        // This breaks the consumer iterator → self-healing catchError → repeat with backoff
        const jsm = await nc.jetstreamManager();
        const stream = streamName(serviceName, StreamKind.Event);
        const consumer = consumerName(serviceName, StreamKind.Event);
        const info = await jsm.consumers.info(stream, consumer);

        await jsm.consumers.delete(stream, consumer);

        // Re-create immediately — self-healing retry will find it after backoff
        await jsm.consumers.add(stream, info.config);

        // Then: self-healing retry finds the re-created consumer and resumes consumption
        await firstValueFrom(client.emit('healing.check', { seq: 2 }));

        await waitForCondition(() => controller.received.length >= 2, 15_000);

        expect(controller.received[1]).toEqual({ seq: 2 });
      },
    );
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
      try {
        await nc.drain();
      } finally {
        await container.stop();
      }
    });

    beforeEach(() => {
      serviceName = uniqueServiceName();
    });

    afterEach(async () => {
      await cleanupStreams(nc, serviceName);
    });

    it(
      'should deliver events after destroy and restart with a new app',
      { timeout: 30_000 },
      async () => {
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
      },
    );
  });
});
