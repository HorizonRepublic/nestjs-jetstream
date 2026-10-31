import { Controller, type INestApplication } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';

import { jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getClientToken, JetstreamClient, StreamKind } from '../../src';
import { NameResolver } from '../../src/server/infrastructure/name-resolver';
import { cleanupStreams, createNatsConnection, createTestApp, uniqueServiceName } from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class ExactController {
  @MessagePattern('orders.created')
  created(): string {
    return 'created';
  }

  @MessagePattern('orders.cancelled')
  cancelled(): string {
    return 'cancelled';
  }
}

@Controller()
class WildcardController {
  @MessagePattern('orders.*')
  order(): string {
    return 'wildcard';
  }

  @MessagePattern('orders.created')
  created(): string {
    return 'created';
  }
}

describe('Consumer filter updates', () => {
  let container: StartedTestContainer | undefined;
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
      await container?.stop();
    }
  });

  it('switches a persisted consumer between multiple filters and one wildcard', async () => {
    const name = uniqueServiceName();
    const prefix = `company.${name}.rpc.`;
    const rpc = { mode: 'jetstream' as const, subjectPrefix: prefix };
    const names = new NameResolver({ name, servers: [], rpc });
    const jsm = await jetstreamManager(nc);
    let app: INestApplication | undefined;

    try {
      for (const controller of [ExactController, WildcardController, ExactController]) {
        const started = await createTestApp({ name, port, rpc }, [controller], [name]);

        app = started.app;

        const info = await jsm.consumers.info(
          names.streamName(StreamKind.Command),
          names.consumerName(StreamKind.Command),
        );
        const client = started.module.get<JetstreamClient>(getClientToken(name));
        const wildcard = controller === WildcardController;

        expect(info.config.filter_subject ?? '').toBe(wildcard ? `${prefix}orders.*` : '');
        expect(info.config.filter_subjects ?? []).toEqual(
          wildcard ? [] : [`${prefix}orders.created`, `${prefix}orders.cancelled`],
        );

        await expect(firstValueFrom(client.send('orders.created', {}))).resolves.toBe('created');
        await expect(firstValueFrom(client.send('orders.cancelled', {}))).resolves.toBe(
          wildcard ? 'wildcard' : 'cancelled',
        );
        await app.close();
        app = undefined;
      }
    } finally {
      await app?.close();
      await cleanupStreams(nc, name);
    }
  });
});
