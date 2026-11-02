import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, Ctx, EventPattern, Payload } from '@nestjs/microservices';

import { jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  ConfigErrorReason,
  getClientToken,
  JetstreamConfigError,
  JetstreamRecordBuilder,
  RpcContext,
  StreamKind,
} from '../../src';
import type { JetstreamModuleOptions } from '../../src';
import { NameResolver } from '../../src/server/infrastructure/name-resolver';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

interface Delivery {
  handler: string;
  subject: string;
}

@Controller()
class EventController {
  public readonly received: Delivery[] = [];

  @EventPattern<string>('orders.*')
  order(@Ctx() ctx: RpcContext): void {
    this.received.push({ handler: 'orders.*', subject: ctx.getSubject() });
  }

  @EventPattern<string>('orders.special')
  special(@Ctx() ctx: RpcContext): void {
    this.received.push({ handler: 'orders.special', subject: ctx.getSubject() });
  }

  @EventPattern<string>('audit.>')
  audit(@Ctx() ctx: RpcContext): void {
    this.received.push({ handler: 'audit.>', subject: ctx.getSubject() });
  }

  @EventPattern<string>('promo.*', { broadcast: true })
  promo(@Ctx() ctx: RpcContext): void {
    this.received.push({ handler: 'promo.*', subject: ctx.getSubject() });
  }

  @EventPattern<string>('ledger.>', { ordered: true })
  ledger(@Payload() data: { seq: number }, @Ctx() ctx: RpcContext): void {
    this.received.push({ handler: `ledger.> #${data.seq}`, subject: ctx.getSubject() });
  }
}

@Controller()
class PrefixedEventController {
  public readonly received: Delivery[] = [];

  @EventPattern<string>('*.created')
  created(@Ctx() ctx: RpcContext): void {
    this.received.push({ handler: '*.created', subject: ctx.getSubject() });
  }

  @EventPattern<string>('orders.created')
  exact(@Ctx() ctx: RpcContext): void {
    this.received.push({ handler: 'orders.created', subject: ctx.getSubject() });
  }
}

@Controller()
class HolderCoveringController {
  @EventPattern('>')
  everything(@Payload() _data: unknown): void {
    // Never registered: the pattern covers the schedule holders.
  }
}

describe('Wildcard handler patterns', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;
  let app: INestApplication | undefined;
  let serviceName: string;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await cleanupStreams(nc, serviceName);
  });

  afterAll(async () => {
    try {
      await nc.drain();
    } finally {
      await container.stop();
    }
  });

  describe('default subject prefixes', () => {
    let client: ClientProxy;
    let controller: EventController;

    const start = async (): Promise<void> => {
      serviceName = uniqueServiceName();

      const started = await createTestApp(
        { name: serviceName, port },
        [EventController],
        [serviceName],
      );

      app = started.app;
      client = started.module.get<ClientProxy>(getClientToken(serviceName));
      controller = started.module.get(EventController);
    };

    it('routes workqueue events to wildcard handlers, preferring exact ones', async () => {
      // Given
      await start();
      const prefix = `${serviceName}__microservice.ev.`;

      // When
      await firstValueFrom(client.emit('orders.created', {}));
      await firstValueFrom(client.emit('orders.special', {}));
      await firstValueFrom(client.emit('audit.eu.orders.created', {}));
      await waitForCondition(() => controller.received.length === 3, 10_000);

      // Then
      expect(controller.received).toEqual(
        expect.arrayContaining([
          { handler: 'orders.*', subject: `${prefix}orders.created` },
          { handler: 'orders.special', subject: `${prefix}orders.special` },
          { handler: 'audit.>', subject: `${prefix}audit.eu.orders.created` },
        ]),
      );
    }, 30_000);

    it('routes broadcasts through a wildcard consumer filter', async () => {
      // Given
      await start();
      const names = new NameResolver({ name: serviceName, servers: [] });
      const jsm = await jetstreamManager(nc);

      // When
      await firstValueFrom(client.emit('broadcast:promo.started', {}));
      await waitForCondition(() => controller.received.length === 1, 10_000);

      // Then
      const info = await jsm.consumers.info(
        names.streamName(StreamKind.Broadcast),
        names.consumerName(StreamKind.Broadcast),
      );

      expect(info.config.filter_subject).toBe('broadcast.promo.*');
      expect(controller.received).toEqual([
        { handler: 'promo.*', subject: 'broadcast.promo.started' },
      ]);
    }, 30_000);

    it('delivers ordered events matched by a wildcard in publish order', async () => {
      // Given
      await start();
      const prefix = `${serviceName}__microservice.ordered.`;

      // When
      for (const seq of [1, 2, 3]) {
        await firstValueFrom(client.emit(`ordered:ledger.eu.${seq}`, { seq }));
      }

      await waitForCondition(() => controller.received.length === 3, 10_000);

      // Then
      expect(controller.received).toEqual([
        { handler: 'ledger.> #1', subject: `${prefix}ledger.eu.1` },
        { handler: 'ledger.> #2', subject: `${prefix}ledger.eu.2` },
        { handler: 'ledger.> #3', subject: `${prefix}ledger.eu.3` },
      ]);
    }, 30_000);
  });

  describe('custom event subject prefix', () => {
    it('collapses covered filters and leaves schedule holders to the scheduler', async () => {
      // Given: a wildcard that stays clear of the "_sch." holders on a scheduling stream
      serviceName = uniqueServiceName();
      const options: JetstreamModuleOptions = {
        name: serviceName,
        servers: [],
        events: { subjectPrefix: `acme.${serviceName}.ev.`, stream: { allow_msg_schedules: true } },
      };
      const started = await createTestApp(
        { ...options, port },
        [PrefixedEventController],
        [serviceName],
      );
      const names = new NameResolver(options);
      const prefix = `acme.${serviceName}.ev.`;

      app = started.app;
      const client = started.module.get<ClientProxy>(getClientToken(serviceName));
      const controller = started.module.get(PrefixedEventController);
      const jsm = await jetstreamManager(nc);

      // When
      await firstValueFrom(client.emit('users.created', {}));
      await firstValueFrom(client.emit('orders.created', {}));
      await firstValueFrom(
        client.emit(
          'invoices.created',
          new JetstreamRecordBuilder({}).scheduleAt(new Date(Date.now() + 1_000)).build(),
        ),
      );
      await waitForCondition(() => controller.received.length === 3, 15_000);

      // Then
      const info = await jsm.consumers.info(
        names.streamName(StreamKind.Event),
        names.consumerName(StreamKind.Event),
      );

      expect(info.config.filter_subject).toBe(`${prefix}*.created`);
      expect(controller.received).toEqual(
        expect.arrayContaining([
          { handler: '*.created', subject: `${prefix}users.created` },
          { handler: 'orders.created', subject: `${prefix}orders.created` },
          { handler: '*.created', subject: `${prefix}invoices.created` },
        ]),
      );
    }, 30_000);

    it('refuses to start a wildcard that would consume schedule holders', async () => {
      // Given
      serviceName = uniqueServiceName();

      // When
      const starting = createTestApp(
        { name: serviceName, port, events: { subjectPrefix: `acme.${serviceName}.ev.` } },
        [HolderCoveringController],
      );

      // Then
      await expect(starting).rejects.toThrow(JetstreamConfigError);
      await expect(starting).rejects.toMatchObject({
        reason: ConfigErrorReason.InvalidHandlerPattern,
      });
    }, 30_000);
  });
});
