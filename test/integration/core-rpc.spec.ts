import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, Ctx, MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import type { NatsConnection } from '@nats-io/transport-node';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';

import { getClientToken, JetstreamRecordBuilder, RpcContext } from '../../src';

import { cleanupStreams, createNatsConnection, createTestApp, uniqueServiceName } from './helpers';
import { startNatsContainer } from './nats-container';

// ---------------------------------------------------------------------------
// Test Controllers
// ---------------------------------------------------------------------------

@Controller()
class RpcController {
  @MessagePattern('user.get')
  getUser(@Payload() data: { id: number }): { id: number; name: string } {
    return { id: data.id, name: 'Test User' };
  }

  @MessagePattern('user.fail')
  failHandler(): never {
    throw new RpcException('User not found');
  }

  @MessagePattern('user.get-with-ctx')
  getUserWithCtx(
    @Payload() data: { id: number },
    @Ctx() ctx: RpcContext,
  ): { id: number; tenant: string | undefined } {
    return { id: data.id, tenant: ctx.getHeader('x-tenant') };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Core RPC Round-Trip', () => {
  let nc: NatsConnection;
  let app: INestApplication;
  let module: TestingModule;
  let client: ClientProxy;
  let serviceName: string;
  let container: StartedTestContainer;
  let port: number;

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
      { name: serviceName, port },
      [RpcController],
      [serviceName], // register forFeature client for the same service
    ));

    client = module.get<ClientProxy>(getClientToken(serviceName));
  });

  afterEach(async () => {
    await app.close();
    await cleanupStreams(nc, serviceName);
  });

  it('should send RPC request and receive response', async () => {
    const result = await firstValueFrom(client.send('user.get', { id: 42 }));

    expect(result).toEqual({ id: 42, name: 'Test User' });
  });

  it('should receive RpcException error from handler', async () => {
    await expect(firstValueFrom(client.send('user.fail', {}))).rejects.toMatchObject({
      message: 'User not found',
    });
  });

  it('should pass custom headers to handler via RpcContext', async () => {
    const record = new JetstreamRecordBuilder({ id: 1 }).setHeader('x-tenant', 'acme').build();

    const result = await firstValueFrom(client.send('user.get-with-ctx', record));

    expect(result).toEqual({ id: 1, tenant: 'acme' });
  });

  it('should return error immediately when no handler matches', async () => {
    const record = new JetstreamRecordBuilder({}).setTimeout(500).build();

    await expect(firstValueFrom(client.send('nonexistent.pattern', record))).rejects.toThrow(
      /no handler/i,
    );
  });
});
