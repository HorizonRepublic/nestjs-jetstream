import { Controller } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EventPattern, Payload, RpcException } from '@nestjs/microservices';
import type { ClientProxy } from '@nestjs/microservices';
import type { TestingModule } from '@nestjs/testing';

import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSubject,
  ConfigErrorReason,
  DeadLetterOrigin,
  getClientToken,
  JetstreamConfigError,
  JetstreamDlq,
  RedriveSkipReason,
  StreamKind,
} from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class FlakyController {
  public failing = true;
  public readonly handled: unknown[] = [];

  @EventPattern('order.created')
  public onCreated(@Payload() data: unknown): void {
    if (this.failing) throw new RpcException('payment gateway timeout');
    this.handled.push(data);
  }

  @EventPattern('order.paid')
  public onPaid(@Payload() data: unknown): void {
    if (this.failing) throw new RpcException('ledger offline');
    this.handled.push(data);
  }

  @EventPattern<string>('config.changed', { broadcast: true })
  public onConfigChanged(): void {
    throw new Error('cache offline');
  }
}

describe('DLQ redrive', () => {
  let container: StartedTestContainer;
  let nc: NatsConnection;
  let port: number;
  let serviceName: string;
  let app: INestApplication;
  let module: TestingModule;
  let client: ClientProxy;
  let controller: FlakyController;
  let sut: JetstreamDlq;

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
    serviceName = uniqueServiceName();
    ({ app, module } = await createTestApp(
      {
        name: serviceName,
        port,
        events: { consumer: { max_deliver: 1 } },
        broadcast: { consumer: { max_deliver: 1 } },
      },
      [FlakyController],
      [serviceName],
    ));
    client = module.get<ClientProxy>(getClientToken(serviceName));
    controller = module.get(FlakyController);
    sut = module.get(JetstreamDlq);
  });

  afterEach(async () => {
    await app.close();
    await cleanupStreams(nc, serviceName);
  });

  const deadLetter = async (pattern: string, data: unknown): Promise<void> => {
    const before = (await sut.inspect()).length;

    await firstValueFrom(client.emit(pattern, data));
    await waitForCondition(async () => (await sut.inspect()).length > before, 10_000);
  };

  it('should describe each dead letter', async () => {
    // Given
    await deadLetter('order.created', { id: 'a' });
    await deadLetter('order.paid', { id: 'b' });

    // When
    const records = await sut.inspect({ pattern: 'order.created' });

    // Then
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      subject: buildSubject(serviceName, StreamKind.Event, 'order.created'),
      origin: DeadLetterOrigin.Event,
      pattern: 'order.created',
      reason: expect.stringContaining('payment gateway timeout'),
      deliveryCount: 1,
      redriveCount: 0,
      payload: { id: 'a' },
    });
    expect(records[0]!.failedAt).toBeInstanceOf(Date);
  });

  it('should hand the chosen dead letters back to their handler once it is fixed', async () => {
    // Given
    await deadLetter('order.created', { id: 'a' });
    await deadLetter('order.created', { id: 'b' });
    await deadLetter('order.paid', { id: 'c' });
    controller.failing = false;

    // When
    const report = await sut.redrive({ pattern: 'order.created' });

    // Then
    expect(report).toMatchObject({ dryRun: false, matched: 2, skipped: [], notRemoved: [] });
    expect(report.redriven).toHaveLength(2);
    await waitForCondition(() => controller.handled.length === 2, 10_000);
    expect(controller.handled).toEqual(expect.arrayContaining([{ id: 'a' }, { id: 'b' }]));
    expect((await sut.inspect()).map((r) => r.pattern)).toEqual(['order.paid']);
  });

  it('should change nothing on a dry run', async () => {
    // Given
    await deadLetter('order.created', { id: 'a' });
    controller.failing = false;

    // When
    const report = await sut.redrive({}, { dryRun: true });

    // Then
    expect(report).toMatchObject({ dryRun: true, matched: 1 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(controller.handled).toEqual([]);
    expect(await sut.inspect()).toHaveLength(1);
  });

  it('should count redrives and stop at the limit', async () => {
    // Given: the handler keeps failing, so the redriven message dead-letters again
    await deadLetter('order.created', { id: 'a' });
    await sut.redrive();
    await waitForCondition(
      async () => (await sut.inspect()).some((r) => r.redriveCount === 1),
      10_000,
    );

    // When
    const report = await sut.redrive({}, { maxRedrives: 1 });

    // Then
    expect(report.redriven).toEqual([]);
    expect(report.skipped).toEqual([
      expect.objectContaining({ reason: RedriveSkipReason.RedriveLimit }),
    ]);
  });

  it('should never redrive a broadcast, but let it be purged', async () => {
    // Given
    await deadLetter('order.created', { id: 'a' });
    await deadLetter('broadcast:config.changed', { flag: true });

    // When
    const report = await sut.redrive({}, { dryRun: true });
    const purged = await sut.purge({ subject: 'broadcast.>' });

    // Then
    expect(report.skipped).toEqual([
      expect.objectContaining({ reason: RedriveSkipReason.Broadcast }),
    ]);
    expect(purged.purged).toHaveLength(1);
    expect((await sut.inspect()).map((r) => r.origin)).toEqual([DeadLetterOrigin.Event]);
  });
});

describe('DLQ redrive without a DLQ', () => {
  let container: StartedTestContainer;
  let port: number;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
  });

  afterAll(async () => {
    await container.stop();
  });

  it('should refuse when the dead-letter stream is off', async () => {
    // Given
    const { app, module } = await createTestApp({ name: uniqueServiceName(), port, dlq: false }, [
      FlakyController,
    ]);

    // When/Then
    try {
      await expect(module.get(JetstreamDlq).inspect()).rejects.toThrow(
        expect.objectContaining({
          constructor: JetstreamConfigError,
          reason: ConfigErrorReason.DlqUnavailable,
        }),
      );
    } finally {
      await app.close();
    }
  });
});
