import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern } from '@nestjs/microservices';
import { NatsConnection, RetentionPolicy } from 'nats';

import { nanos } from '../../src';

import { cleanupStreams, createNatsConnection, createTestApp, uniqueServiceName } from './helpers';

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

  beforeAll(async () => {
    nc = await createNatsConnection();
  });

  afterAll(async () => {
    await nc.drain();
  });

  describe('stream creation', () => {
    it('should create event stream with workqueue retention', async () => {
      const serviceName = uniqueServiceName();

      const { app } = await createTestApp({ name: serviceName }, [InfraEventController]);

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

    it('should create broadcast stream with limits retention', async () => {
      const serviceName = uniqueServiceName();

      const { app } = await createTestApp({ name: serviceName }, [InfraEventController]);

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

      const { app } = await createTestApp({ name: serviceName, rpc: { mode: 'jetstream' } }, [
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

      const { app } = await createTestApp({ name: serviceName }, [InfraRpcController]);

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
      const customMaxAge = nanos(5 * 60 * 1000); // 5 minutes (must exceed duplicate_window default of 2 min)

      const { app } = await createTestApp(
        {
          name: serviceName,
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

      const { app } = await createTestApp({ name: serviceName }, [InfraEventController]);

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

      const { app } = await createTestApp({ name: serviceName }, [InfraEventController]);

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
      const { app: app1 } = await createTestApp({ name: serviceName }, [InfraEventController]);

      await app1.close();

      // Second bootstrap — same service name
      const { app: app2 } = await createTestApp({ name: serviceName }, [InfraEventController]);

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
});
