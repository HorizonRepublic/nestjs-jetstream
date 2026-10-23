import { Controller, INestApplication } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import { jetstreamManager, jetstream } from '@nats-io/jetstream';
import { RetentionPolicy } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { consumerName, internalName, StreamKind, streamName } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class TickController {
  public readonly received: unknown[] = [];

  @EventPattern('reminder.due', { schedule: true })
  due(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

describe('Schedule stream', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;
  let app: INestApplication;
  let service: string;
  let controller: TickController;

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

  beforeEach(async () => {
    service = uniqueServiceName();
    ({ app } = await createTestApp({ name: service, port }, [TickController]));
    controller = app.get(TickController);
  });

  afterEach(async () => {
    await app.close();
    await cleanupStreams(nc, service);
  });

  it('should provision a stream that keeps holders and a consumer that skips them', async () => {
    // When
    const jsm = await jetstreamManager(nc);
    const stream = await jsm.streams.info(streamName(service, StreamKind.Schedule));
    const consumer = await jsm.consumers.info(
      stream.config.name,
      consumerName(service, StreamKind.Schedule),
    );

    // Then
    expect(stream.config.subjects).toEqual([
      `${internalName(service)}.sched.>`,
      `${internalName(service)}._cron.>`,
    ]);
    expect(stream.config.retention).toBe(RetentionPolicy.Workqueue);
    expect(stream.config.max_age).toBe(0);
    expect(stream.config.allow_msg_schedules).toBe(true);
    expect(stream.config.allow_msg_ttl).toBe(true);
    expect(consumer.config.filter_subject).toBe(`${internalName(service)}.sched.>`);
  });

  it('should route a tick to its handler and leave holders alone', async () => {
    // Given
    const js = jetstream(nc);

    // When a tick and a holder-shaped message land in the stream
    await js.publish(`${internalName(service)}.sched.reminder.due`, JSON.stringify({ id: 1 }));
    await js.publish(`${internalName(service)}._cron.dyn.reminder-1`, JSON.stringify({ id: 2 }));

    // Then only the tick is delivered, and the holder stays stored
    await waitForCondition(() => controller.received.length === 1, 10_000);
    expect(controller.received).toEqual([{ id: 1 }]);

    const jsm = await jetstreamManager(nc);
    const info = await jsm.streams.info(streamName(service, StreamKind.Schedule), {
      subjects_filter: `${internalName(service)}._cron.>`,
    });

    expect(info.state.subjects).toEqual({ [`${internalName(service)}._cron.dyn.reminder-1`]: 1 });
  });
});
