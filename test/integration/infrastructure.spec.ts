import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern } from '@nestjs/microservices';
import { NatsConnection, RetentionPolicy, StoreCompression } from 'nats';
import type { StartedTestContainer } from 'testcontainers';

import { toNanos } from '../../src';

import { cleanupStreams, createNatsConnection, createTestApp, uniqueServiceName } from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class InfraEventController {
  @EventPattern('order.created')
  handleOrder(): void {}

  @EventPattern('config.updated', { broadcast: true })
  handleBroadcast(): void {}
}

@Controller()
class InfraRpcController {
  @MessagePattern('user.get')
  getUser(): { id: number } {
    return { id: 1 };
  }
}

describe('Stream & Consumer Lifecycle', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);
  });

  afterAll(async () => {
    try {
      await nc?.drain();
    } finally {
      await container?.stop();
    }
  });

  describe('stream creation', () => {
    it('should create event stream with workqueue retention', async () => {
      const serviceName = uniqueServiceName();

      const { app } = await createTestApp({ name: serviceName, port }, [InfraEventController]);

      try {
        const jsm = await nc.jetstreamManager();
        const internalName = `${serviceName}__microservice`;
        const info = await jsm.streams.info(`${internalName}_ev-stream`);

        expect(info.config.name).toBe(`${internalName}_ev-stream`);
        expect(info.config.subjects).toEqual([`${internalName}.ev.>`]);
        expect(info.config.retention).toBe(RetentionPolicy.Workqueue);
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should create event stream with S2 compression by default', async () => {
      const serviceName = uniqueServiceName();

      const { app } = await createTestApp({ name: serviceName, port }, [InfraEventController]);

      try {
        const jsm = await nc.jetstreamManager();
        const internalName = `${serviceName}__microservice`;
        const info = await jsm.streams.info(`${internalName}_ev-stream`);

        expect(info.config.compression).toBe(StoreCompression.S2);
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should create broadcast stream with limits retention', async () => {
      const serviceName = uniqueServiceName();

      const { app } = await createTestApp({ name: serviceName, port }, [InfraEventController]);

      try {
        const jsm = await nc.jetstreamManager();
        const info = await jsm.streams.info('broadcast-stream');

        expect(info.config.subjects).toEqual(['broadcast.>']);
        expect(info.config.retention).toBe(RetentionPolicy.Limits);
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should create command stream only in jetstream RPC mode', async () => {
      const serviceName = uniqueServiceName();

      const { app } = await createTestApp({ name: serviceName, port, rpc: { mode: 'jetstream' } }, [
        InfraRpcController,
      ]);

      try {
        const jsm = await nc.jetstreamManager();
        const internalName = `${serviceName}__microservice`;
        const info = await jsm.streams.info(`${internalName}_cmd-stream`);

        expect(info.config.name).toBe(`${internalName}_cmd-stream`);
        expect(info.config.subjects).toEqual([`${internalName}.cmd.>`]);
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should NOT create command stream in core RPC mode', async () => {
      const serviceName = uniqueServiceName();

      const { app } = await createTestApp({ name: serviceName, port }, [InfraRpcController]);

      try {
        const jsm = await nc.jetstreamManager();
        const internalName = `${serviceName}__microservice`;

        await expect(jsm.streams.info(`${internalName}_cmd-stream`)).rejects.toThrow();
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should apply user stream config overrides', async () => {
      const serviceName = uniqueServiceName();
      const customMaxAge = toNanos(5, 'minutes');

      const { app } = await createTestApp(
        {
          name: serviceName,
          port,
          events: { stream: { max_age: customMaxAge } },
        },
        [InfraEventController],
      );

      try {
        const jsm = await nc.jetstreamManager();
        const internalName = `${serviceName}__microservice`;
        const info = await jsm.streams.info(`${internalName}_ev-stream`);

        expect(info.config.max_age).toBe(customMaxAge);
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });
  });

  describe('consumer creation', () => {
    it('should create durable event consumer', async () => {
      const serviceName = uniqueServiceName();

      const { app } = await createTestApp({ name: serviceName, port }, [InfraEventController]);

      try {
        const jsm = await nc.jetstreamManager();
        const internalName = `${serviceName}__microservice`;
        const info = await jsm.consumers.info(
          `${internalName}_ev-stream`,
          `${internalName}_ev-consumer`,
        );

        expect(info.config.durable_name).toBe(`${internalName}_ev-consumer`);
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should create broadcast consumer with filter_subjects', async () => {
      const serviceName = uniqueServiceName();

      const { app } = await createTestApp({ name: serviceName, port }, [InfraEventController]);

      try {
        const jsm = await nc.jetstreamManager();
        const internalName = `${serviceName}__microservice`;
        const info = await jsm.consumers.info(
          'broadcast-stream',
          `${internalName}_broadcast-consumer`,
        );

        expect(info.config.durable_name).toBe(`${internalName}_broadcast-consumer`);
        // Single broadcast pattern → filter_subject (not filter_subjects)
        expect(info.config.filter_subject).toBe('broadcast.config.updated');
        expect(info.config.filter_subjects ?? []).toHaveLength(0);
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should apply user consumer config overrides', async () => {
      const serviceName = uniqueServiceName();

      const { app } = await createTestApp(
        {
          name: serviceName,
          port,
          events: { consumer: { max_deliver: 10 } },
        },
        [InfraEventController],
      );

      try {
        const jsm = await nc.jetstreamManager();
        const internalName = `${serviceName}__microservice`;
        const info = await jsm.consumers.info(
          `${internalName}_ev-stream`,
          `${internalName}_ev-consumer`,
        );

        expect(info.config.max_deliver).toBe(10);
      } finally {
        await app.close();
        await cleanupStreams(nc, serviceName);
      }
    });

    it('should be idempotent — re-listen does not duplicate', async () => {
      const serviceName = uniqueServiceName();

      // First bootstrap
      const { app: app1 } = await createTestApp({ name: serviceName, port }, [
        InfraEventController,
      ]);

      await app1.close();

      // Second bootstrap — same service name
      const { app: app2 } = await createTestApp({ name: serviceName, port }, [
        InfraEventController,
      ]);

      try {
        const jsm = await nc.jetstreamManager();
        const internalName = `${serviceName}__microservice`;

        // Stream and consumer should still exist (no error)
        const streamInfo = await jsm.streams.info(`${internalName}_ev-stream`);

        expect(streamInfo).toBeDefined();

        const consumerInfo = await jsm.consumers.info(
          `${internalName}_ev-stream`,
          `${internalName}_ev-consumer`,
        );

        expect(consumerInfo).toBeDefined();
      } finally {
        await app2.close();
        await cleanupStreams(nc, serviceName);
      }
    });
  });

  describe('destroy and re-start lifecycle', () => {
    it('should re-create streams after explicit deletion and re-bootstrap', async () => {
      const serviceName = uniqueServiceName();

      const { app: app1 } = await createTestApp({ name: serviceName, port }, [
        InfraEventController,
      ]);

      await app1.close();

      // Explicitly delete the stream — proving re-bootstrap recreates it
      const jsm = await nc.jetstreamManager();
      const internal = `${serviceName}__microservice`;

      await jsm.streams.delete(`${internal}_ev-stream`);

      const { app: app2 } = await createTestApp({ name: serviceName, port }, [
        InfraEventController,
      ]);

      try {
        const streamInfo = await jsm.streams.info(`${internal}_ev-stream`);

        expect(streamInfo).toBeDefined();
      } finally {
        await app2.close();
        await cleanupStreams(nc, serviceName);
      }
    });
  });
});
