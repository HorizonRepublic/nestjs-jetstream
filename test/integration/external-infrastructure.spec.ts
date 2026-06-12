import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import type { NatsConnection } from '@nats-io/transport-node';
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  type JetStreamManager,
  RetentionPolicy,
  StorageType,
} from '@nats-io/jetstream';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import {
  getClientToken,
  JetstreamProvisioningError,
  JetstreamRecordBuilder,
  ManagementMode,
  toNanos,
} from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  deleteStreamIfExists,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

interface ExternalNames {
  stream: string;
  consumer: string;
  subject: string;
  subjectPrefix: string;
  /** Wildcard covering all subjects for this prefix, used when creating the stream. */
  subjectWildcard: string;
}

const makeExternalNames = (suffix: string): ExternalNames => {
  const prefix = `ext.orders.${suffix}.`;

  return {
    stream: `ext_orders_stream_${suffix}`,
    consumer: `ext_orders_worker_${suffix}`,
    subject: `${prefix}order.created`,
    subjectPrefix: prefix,
    subjectWildcard: `${prefix}>`,
  };
};

const provisionExternal = async (jsm: JetStreamManager, names: ExternalNames): Promise<void> => {
  await jsm.streams.add({
    name: names.stream,
    subjects: [names.subjectWildcard],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    num_replicas: 1,
  });

  await jsm.consumers.add(names.stream, {
    durable_name: names.consumer,
    ack_policy: AckPolicy.Explicit,
    filter_subject: names.subject,
    max_deliver: 3,
    deliver_policy: DeliverPolicy.All,
  });
};

@Controller()
class OrderCreatedController {
  public readonly received: unknown[] = [];

  @EventPattern('order.created')
  handleOrderCreated(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

@Controller()
class AlwaysFailingExternalController {
  public attempts = 0;

  @EventPattern('order.created')
  handleOrderCreated(@Payload() _data: unknown): never {
    this.attempts++;
    throw new Error('Permanent failure — external DLQ test');
  }
}

describe('External Infrastructure (bind-only mode)', () => {
  let container: StartedTestContainer;
  let port: number;
  let nc: NatsConnection;

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

  describe('full-manual round-trip without mutation', () => {
    let app: INestApplication;
    let module: TestingModule;
    let serviceName: string;
    let client: ClientProxy;
    let controller: OrderCreatedController;
    let jsm: JetStreamManager;
    let names: ExternalNames;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      jsm = await jetstreamManager(nc);
      names = makeExternalNames(serviceName);

      await provisionExternal(jsm, names);

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          provisioning: { management: ManagementMode.Manual },
          events: {
            stream: { name: names.stream },
            consumer: { durable_name: names.consumer },
            subjectPrefix: names.subjectPrefix,
          },
        },
        [OrderCreatedController],
        [serviceName],
      ));

      controller = module.get(OrderCreatedController);
      client = module.get<ClientProxy>(getClientToken(serviceName));
    });

    afterEach(async () => {
      await app.close().catch(() => {});
      await cleanupStreams(nc, serviceName).catch(() => {});
      await deleteStreamIfExists(jsm, names.stream);
    });

    it('should deliver events and leave stream/consumer config unchanged', async () => {
      // Given: snapshot config before any library interaction
      const streamBefore = await jsm.streams.info(names.stream);
      const consumerBefore = await jsm.consumers.info(names.stream, names.consumer);

      // When: emit via library client
      await firstValueFrom(client.emit('order.created', { orderId: 'ext-1' }));

      await waitForCondition(() => controller.received.length >= 1, 10_000);

      // Then: message received
      expect(controller.received[0]).toEqual({ orderId: 'ext-1' });

      // And: neither stream nor consumer config was mutated
      const streamAfter = await jsm.streams.info(names.stream);
      const consumerAfter = await jsm.consumers.info(names.stream, names.consumer);

      expect(streamAfter.config).toEqual(streamBefore.config);
      expect(consumerAfter.config).toEqual(consumerBefore.config);
    });
  });

  describe('missing external entity → boot failure', () => {
    let serviceName: string;
    let names: ExternalNames;

    beforeEach(() => {
      serviceName = uniqueServiceName();
      names = makeExternalNames(serviceName);
    });

    afterEach(async () => {
      await cleanupStreams(nc, serviceName);
    });

    it('should reject boot with the external stream name in the error message', async () => {
      // Given: no out-of-band provisioning, stream does not exist

      // When: attempt to boot with Manual mode
      await expect(
        createTestApp(
          {
            name: serviceName,
            port,
            provisioning: { management: ManagementMode.Manual },
            events: {
              stream: { name: names.stream },
              consumer: { durable_name: names.consumer },
              subjectPrefix: names.subjectPrefix,
            },
          },
          [OrderCreatedController],
        ),
      ).rejects.toThrow(names.stream);
    });

    it('should throw a JetstreamProvisioningError on missing external stream', async () => {
      // Given: no out-of-band provisioning

      // When / Then
      await expect(
        createTestApp(
          {
            name: serviceName,
            port,
            provisioning: { management: ManagementMode.Manual },
            events: {
              stream: { name: names.stream },
              consumer: { durable_name: names.consumer },
              subjectPrefix: names.subjectPrefix,
            },
          },
          [OrderCreatedController],
        ),
      ).rejects.toBeInstanceOf(JetstreamProvisioningError);
    });
  });

  describe('mixed ownership: stream Manual, consumer Auto', () => {
    let app: INestApplication;
    let module: TestingModule;
    let serviceName: string;
    let controller: OrderCreatedController;
    let jsm: JetStreamManager;
    let names: ExternalNames;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      jsm = await jetstreamManager(nc);
      names = makeExternalNames(serviceName);

      await jsm.streams.add({
        name: names.stream,
        subjects: [names.subjectWildcard],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        num_replicas: 1,
      });

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          events: {
            stream: { name: names.stream },
            consumer: { durable_name: names.consumer },
            subjectPrefix: names.subjectPrefix,
            management: { stream: ManagementMode.Manual },
          },
        },
        [OrderCreatedController],
        [serviceName],
      ));

      controller = module.get(OrderCreatedController);
    });

    afterEach(async () => {
      await app.close().catch(() => {});
      await cleanupStreams(nc, serviceName).catch(() => {});
      await deleteStreamIfExists(jsm, names.stream);
    });

    it('should create the consumer on the external stream and deliver messages', async () => {
      // Given: library booted, consumer should now exist
      const consumerInfo = await jsm.consumers.info(names.stream, names.consumer);

      expect(consumerInfo).toBeDefined();
      expect(consumerInfo.config.durable_name).toBe(names.consumer);

      // When: publish a message to the external stream subject
      const js = jetstream(nc);

      await js.publish(
        names.subject,
        new TextEncoder().encode(JSON.stringify({ orderId: 'mixed-1' })),
      );

      await waitForCondition(() => controller.received.length >= 1, 10_000);

      // Then: delivery works end-to-end
      expect(controller.received[0]).toEqual({ orderId: 'mixed-1' });
    });
  });

  describe('self-healing rebind: never recreate', () => {
    let app: INestApplication;
    let module: TestingModule;
    let serviceName: string;
    let controller: OrderCreatedController;
    let jsm: JetStreamManager;
    let names: ExternalNames;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      jsm = await jetstreamManager(nc);
      names = makeExternalNames(serviceName);

      await provisionExternal(jsm, names);

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          provisioning: { management: ManagementMode.Manual },
          events: {
            stream: { name: names.stream },
            consumer: { durable_name: names.consumer },
            subjectPrefix: names.subjectPrefix,
          },
        },
        [OrderCreatedController],
        [serviceName],
      ));

      controller = module.get(OrderCreatedController);
    });

    afterEach(async () => {
      await app.close().catch(() => {});
      await cleanupStreams(nc, serviceName).catch(() => {});
      await deleteStreamIfExists(jsm, names.stream);
    });

    it(
      'should rebind to the restored external consumer without recreating it',
      { timeout: 40_000 },
      async () => {
        // Given: verify app started healthy by publishing and consuming one event
        const js = jetstream(nc);

        await js.publish(names.subject, new TextEncoder().encode(JSON.stringify({ seq: 1 })));

        await waitForCondition(() => controller.received.length >= 1, 10_000);

        expect(controller.received[0]).toEqual({ seq: 1 });

        // When: delete the external consumer
        await jsm.consumers.delete(names.stream, names.consumer);

        await js.publish(names.subject, new TextEncoder().encode(JSON.stringify({ seq: 2 })));

        // Then: consumer was NOT recreated; poll for ~5s asserting library never recreates it
        const pollEnd = Date.now() + 5_000;

        while (Date.now() < pollEnd) {
          await expect(jsm.consumers.info(names.stream, names.consumer)).rejects.toThrow();
          await new Promise((r) => setTimeout(r, 200));
        }

        // When: restore the consumer out-of-band with the same filter
        await jsm.consumers.add(names.stream, {
          durable_name: names.consumer,
          ack_policy: AckPolicy.Explicit,
          filter_subject: names.subject,
          max_deliver: 3,
          deliver_policy: DeliverPolicy.All,
        });

        // Then: self-healing rebinds and delivers the pending message
        await waitForCondition(() => controller.received.length >= 2, 20_000);

        expect(controller.received.some((m) => (m as Record<string, unknown>).seq === 2)).toBe(
          true,
        );
      },
    );
  });

  describe('uncovered handler pattern → boot throw', () => {
    let serviceName: string;
    let jsm: JetStreamManager;
    let names: ExternalNames;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      jsm = await jetstreamManager(nc);
      names = makeExternalNames(serviceName);
    });

    afterEach(async () => {
      await cleanupStreams(nc, serviceName);
      await deleteStreamIfExists(jsm, names.stream);
    });

    it('should reject boot when consumer filter does not cover registered handler subjects', async () => {
      // Given: stream exists, consumer filtered to a DIFFERENT subject (not order.created)
      await jsm.streams.add({
        name: names.stream,
        subjects: [names.subjectWildcard],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        num_replicas: 1,
      });

      const uncoveredConsumer = names.consumer;

      await jsm.consumers.add(names.stream, {
        durable_name: uncoveredConsumer,
        ack_policy: AckPolicy.Explicit,
        filter_subject: `${names.subjectPrefix}other.event`,
        max_deliver: 3,
        deliver_policy: DeliverPolicy.All,
      });

      // When / Then: boot should fail because handler 'order.created' is not covered
      const resolvedSubject = `${names.subjectPrefix}order.created`;

      await expect(
        createTestApp(
          {
            name: serviceName,
            port,
            provisioning: { management: ManagementMode.Manual },
            events: {
              stream: { name: names.stream },
              consumer: { durable_name: names.consumer },
              subjectPrefix: names.subjectPrefix,
            },
          },
          [OrderCreatedController],
        ),
      ).rejects.toThrow(resolvedSubject);
    });
  });

  describe('scheduling on external infrastructure', () => {
    let app: INestApplication | undefined;
    let module: TestingModule;
    let serviceName: string;
    let jsm: JetStreamManager;
    let names: ExternalNames;

    beforeEach(() => {
      serviceName = uniqueServiceName();
      names = makeExternalNames(serviceName);
    });

    afterEach(async () => {
      await app?.close().catch(() => {});
      app = undefined;
      await cleanupStreams(nc, serviceName).catch(() => {});
      await deleteStreamIfExists(jsm, names.stream);
    });

    it('should reject boot when the external consumer filter would swallow schedule holders', async () => {
      // Given: schedule-capable stream but a catch-all consumer filter
      jsm = await jetstreamManager(nc);

      await jsm.streams.add({
        name: names.stream,
        subjects: [names.subjectWildcard],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        num_replicas: 1,
        allow_msg_schedules: true,
      });

      await jsm.consumers.add(names.stream, {
        durable_name: names.consumer,
        ack_policy: AckPolicy.Explicit,
        filter_subject: names.subjectWildcard,
        max_deliver: 3,
        deliver_policy: DeliverPolicy.All,
      });

      // When / Then: boot rejects naming the schedule namespace
      await expect(
        createTestApp(
          {
            name: serviceName,
            port,
            provisioning: { management: ManagementMode.Manual },
            events: {
              stream: { name: names.stream, allow_msg_schedules: true },
              consumer: { durable_name: names.consumer },
              subjectPrefix: names.subjectPrefix,
            },
          },
          [OrderCreatedController],
        ),
      ).rejects.toThrow(`${names.subjectPrefix}_sch.`);
    });

    it('should deliver a scheduled event through externally managed infrastructure', async () => {
      // Given: schedule-capable stream and an exact-filter consumer
      jsm = await jetstreamManager(nc);

      await jsm.streams.add({
        name: names.stream,
        subjects: [names.subjectWildcard],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        num_replicas: 1,
        allow_msg_schedules: true,
      });

      await jsm.consumers.add(names.stream, {
        durable_name: names.consumer,
        ack_policy: AckPolicy.Explicit,
        filter_subject: names.subject,
        max_deliver: 3,
        deliver_policy: DeliverPolicy.All,
      });

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          provisioning: { management: ManagementMode.Manual },
          events: {
            stream: { name: names.stream, allow_msg_schedules: true },
            consumer: { durable_name: names.consumer },
            subjectPrefix: names.subjectPrefix,
          },
        },
        [OrderCreatedController],
        [serviceName],
      ));

      const controller = module.get(OrderCreatedController);
      const client = module.get<ClientProxy>(getClientToken(serviceName));

      // When: schedule a one-shot delivery 2 seconds out
      const record = new JetstreamRecordBuilder({ orderId: 'sched-ext-1' })
        .scheduleAt(new Date(Date.now() + 2_000))
        .build();

      await firstValueFrom(client.emit('order.created', record));

      // Then: nothing is delivered before the schedule fires, then the handler receives it
      expect(controller.received).toHaveLength(0);

      await waitForCondition(() => controller.received.length >= 1, 15_000);

      expect(controller.received[0]).toEqual({ orderId: 'sched-ext-1' });
    }, 30_000);
  });

  describe('external DLQ stream', () => {
    let app: INestApplication;
    let module: TestingModule;
    let serviceName: string;
    let controller: AlwaysFailingExternalController;
    let jsm: JetStreamManager;
    let names: ExternalNames;
    let dlqStreamName: string;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      jsm = await jetstreamManager(nc);
      names = makeExternalNames(serviceName);
      dlqStreamName = `ext_dlq_${serviceName}`;

      await provisionExternal(jsm, names);

      await jsm.streams.add({
        name: dlqStreamName,
        subjects: [dlqStreamName],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        num_replicas: 1,
      });

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          provisioning: { management: ManagementMode.Manual },
          events: {
            stream: { name: names.stream },
            consumer: {
              durable_name: names.consumer,
              max_deliver: 2,
              ack_wait: toNanos(2, 'seconds'),
            },
            subjectPrefix: names.subjectPrefix,
          },
          dlq: {
            stream: { name: dlqStreamName },
            management: { stream: ManagementMode.Manual },
          },
        },
        [AlwaysFailingExternalController],
        [serviceName],
      ));

      controller = module.get(AlwaysFailingExternalController);
    });

    afterEach(async () => {
      await app.close().catch(() => {});
      await cleanupStreams(nc, serviceName).catch(() => {});
      await deleteStreamIfExists(jsm, names.stream);
      await deleteStreamIfExists(jsm, dlqStreamName);
    });

    it('should republish dead letters to the external DLQ stream', async () => {
      // Given: publish a message that the handler will always fail
      const js = jetstream(nc);

      await js.publish(
        names.subject,
        new TextEncoder().encode(JSON.stringify({ orderId: 'dlq-ext-1' })),
      );

      // When: all delivery attempts are exhausted (max_deliver=2, ack_wait=2s)
      await waitForCondition(() => controller.attempts >= 2, 15_000);

      // Then: the dead letter lands in the external DLQ stream
      await waitForCondition(async () => {
        const info = await jsm.streams.info(dlqStreamName);

        return info.state.messages >= 1;
      }, 10_000);

      const msg = await jsm.streams.getMessage(dlqStreamName, { seq: 1 });

      expect(msg).toBeDefined();

      const decoded = JSON.parse(new TextDecoder().decode(msg!.data));

      expect(decoded.orderId).toBe('dlq-ext-1');
    });
  });
});
