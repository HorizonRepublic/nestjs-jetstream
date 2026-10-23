import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';

import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getClientToken, JetstreamModule, JetstreamRecordBuilder } from '../../src';
import type { TargetSubjectPrefixes } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class AssetController {
  public readonly events: unknown[] = [];
  public readonly ordered: unknown[] = [];

  @MessagePattern('asset.get')
  get(@Payload() data: { id: string }): { id: string; found: boolean } {
    return { id: data.id, found: true };
  }

  @EventPattern('asset.changed')
  changed(@Payload() data: unknown): void {
    this.events.push(data);
  }

  @EventPattern('asset.moved', { ordered: true })
  moved(@Payload() data: unknown): void {
    this.ordered.push(data);
  }
}

describe('Target subject prefixes', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;

  let target: INestApplication;
  let caller: INestApplication;
  let targetName: string;
  let callerName: string;
  let client: ClientProxy;
  let controller: AssetController;

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
    targetName = uniqueServiceName();
    callerName = uniqueServiceName();

    const prefixes: TargetSubjectPrefixes = {
      rpc: `acme.${targetName}.rpc`,
      events: `acme.${targetName}.ev`,
      ordered: `acme.${targetName}.ord`,
    };

    ({ app: target } = await createTestApp(
      {
        name: targetName,
        port,
        rpc: { mode: 'jetstream', subjectPrefix: prefixes.rpc },
        events: { subjectPrefix: prefixes.events, stream: { allow_msg_schedules: true } },
        ordered: { subjectPrefix: prefixes.ordered },
      },
      [AssetController],
    ));
    controller = target.get(AssetController);

    const module = await Test.createTestingModule({
      imports: [
        JetstreamModule.forRoot({
          name: callerName,
          servers: [`nats://localhost:${port}`],
          rpc: { mode: 'jetstream' },
          publisherOnly: true,
        }),
        JetstreamModule.forFeature({ name: targetName, subjectPrefix: prefixes }),
      ],
    }).compile();

    caller = module.createNestApplication({ logger: false });
    await caller.init();
    client = caller.get<ClientProxy>(getClientToken(targetName));
  });

  afterEach(async () => {
    await caller.close();
    await target.close();
    await cleanupStreams(nc, targetName);
    await cleanupStreams(nc, callerName);
  });

  it('should reach an RPC handler under a custom rpc prefix', async () => {
    // When
    const reply = await firstValueFrom(client.send('asset.get', { id: 'a-1' }));

    // Then
    expect(reply).toEqual({ id: 'a-1', found: true });
  });

  it('should deliver an event under a custom events prefix', async () => {
    // When
    await firstValueFrom(client.emit('asset.changed', { id: 'a-2' }));

    // Then
    await waitForCondition(() => controller.events.length === 1, 10_000);
    expect(controller.events).toEqual([{ id: 'a-2' }]);
  });

  it('should deliver an ordered event under a custom ordered prefix', async () => {
    // When
    await firstValueFrom(client.emit('ordered:asset.moved', { id: 'a-3' }));

    // Then
    await waitForCondition(() => controller.ordered.length === 1, 10_000);
    expect(controller.ordered).toEqual([{ id: 'a-3' }]);
  });

  it('should deliver a scheduled event under a custom events prefix', async () => {
    // Given
    const record = new JetstreamRecordBuilder({ id: 'a-4' })
      .scheduleAt(new Date(Date.now() + 1_500))
      .build();

    // When
    await firstValueFrom(client.emit('asset.changed', record));

    // Then
    await waitForCondition(() => controller.events.length === 1, 15_000);
    expect(controller.events).toEqual([{ id: 'a-4' }]);
  });
});
