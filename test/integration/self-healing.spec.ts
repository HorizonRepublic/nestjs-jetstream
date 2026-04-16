import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import type { NatsConnection } from '@nats-io/transport-node';
import { jetstreamManager, type JetStreamManager } from '@nats-io/jetstream';
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
        const jsm = await jetstreamManager(nc);
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

  describe('consumer recovery (auto-recreate on not found)', () => {
    let nc: NatsConnection;
    let jsm: JetStreamManager;
    let container: StartedTestContainer;
    let port: number;

    beforeAll(async () => {
      ({ container, port } = await startNatsContainer());
      nc = await createNatsConnection(port);
      jsm = await jetstreamManager(nc);
    }, 60_000);

    afterAll(async () => {
      try {
        await nc.drain();
      } finally {
        await container.stop();
      }
    });

    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let controller: SelfHealingController;

    beforeEach(async () => {
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
      await app.close().catch(() => {});
      await cleanupStreams(nc, serviceName).catch(() => {});
    });

    it('should block consumer recovery while migration backup exists', async () => {
      // Given: message consumed successfully
      await firstValueFrom(client.emit('healing.check', { phase: 'initial' }));

      await waitForCondition(() => controller.received.length >= 1, 10_000);

      const evStream = streamName(serviceName, StreamKind.Event);
      const evConsumer = consumerName(serviceName, StreamKind.Event);
      const backupName = `${evStream}__migration_backup`;

      // When: simulate migration — create backup stream, then delete consumer

      await jsm.streams.add({
        name: backupName,
        subjects: [],
        num_replicas: 1,
      });

      await jsm.consumers.delete(evStream, evConsumer);

      // Publish a message while backup exists
      await firstValueFrom(client.emit('healing.check', { phase: 'during-migration' }));

      // Wait enough for self-healing to attempt recovery (several retry cycles)
      await new Promise((r) => setTimeout(r, 3_000));

      // Then: consumer should NOT be recreated — backup blocks recovery
      await expect(jsm.consumers.info(evStream, evConsumer)).rejects.toThrow();

      // Only the first message was consumed
      expect(controller.received).toHaveLength(1);

      // When: "migration completes" — delete backup stream
      await jsm.streams.delete(backupName);

      // Then: self-healing recovers, consumer recreated, pending message delivered
      await waitForCondition(() => controller.received.length >= 2, 30_000);

      // At least both phases arrived — redelivery after consumer recreation
      // may add duplicates, which is correct at-least-once behaviour.
      expect(controller.received.length).toBeGreaterThanOrEqual(2);
      const phases = controller.received.map((m) => (m as Record<string, unknown>).phase);

      expect(phases).toContain('initial');
      expect(phases).toContain('during-migration');
    }, 60_000);

    it('should recreate event consumer after manual deletion and resume consumption', async () => {
      // Given: message consumed successfully
      await firstValueFrom(client.emit('healing.check', { phase: 'before-delete' }));

      await waitForCondition(() => controller.received.length >= 1, 10_000);

      expect(controller.received.length).toBeGreaterThanOrEqual(1);

      // When: delete consumer via NATS
      const evStream = streamName(serviceName, StreamKind.Event);
      const evConsumer = consumerName(serviceName, StreamKind.Event);

      await jsm.consumers.delete(evStream, evConsumer);

      // And: publish another message
      await firstValueFrom(client.emit('healing.check', { phase: 'after-delete' }));

      // Then: self-healing recreates consumer and message is delivered.
      // Redelivery of "before-delete" may occur since consumer was deleted
      // before the ack was persisted — this is correct at-least-once behaviour.
      const getPhases = (): string[] =>
        controller.received.map((m) => (m as Record<string, unknown>).phase as string);

      await waitForCondition(() => getPhases().includes('after-delete'), 30_000);

      expect(getPhases()).toContain('before-delete');
      expect(getPhases()).toContain('after-delete');
    }, 60_000);
  });
});
