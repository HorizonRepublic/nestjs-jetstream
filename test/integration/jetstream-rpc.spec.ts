import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, Ctx, MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { NatsConnection } from 'nats';
import { firstValueFrom } from 'rxjs';

import { getClientToken, JetstreamRecordBuilder, RpcContext } from '../../src';

import { cleanupStreams, createNatsConnection, createTestApp, uniqueServiceName } from './helpers';

// ---------------------------------------------------------------------------
// Test Controllers
// ---------------------------------------------------------------------------

@Controller()
class JsRpcController {
  @MessagePattern('user.get')
  getUser(@Payload() data: { id: number }): { id: number; name: string } {
    return { id: data.id, name: 'JS User' };
  }

  @MessagePattern('user.fail')
  failHandler(): never {
    throw new RpcException('Not found');
  }

  @MessagePattern('user.ctx')
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

describe('JetStream RPC Round-Trip', () => {
  let nc: NatsConnection;
  let app: INestApplication;
  let module: TestingModule;
  let client: ClientProxy;
  let serviceName: string;

  beforeAll(async () => {
    nc = await createNatsConnection();
  });

  afterAll(async () => {
    await nc.drain();
  });

  beforeEach(async () => {
    serviceName = uniqueServiceName();

    ({ app, module } = await createTestApp(
      { name: serviceName, rpc: { mode: 'jetstream', timeout: 5_000 } },
      [JsRpcController],
      [serviceName],
    ));

    client = module.get<ClientProxy>(getClientToken(serviceName));
  });

  afterEach(async () => {
    await app.close();
    await cleanupStreams(nc, serviceName);
  });

  it('should send JetStream RPC request and receive response via inbox', async () => {
    const result = await firstValueFrom(client.send('user.get', { id: 7 }));

    expect(result).toEqual({ id: 7, name: 'JS User' });
  });

  it('should receive RpcException error via inbox', async () => {
    await expect(firstValueFrom(client.send('user.fail', {}))).rejects.toMatchObject({
      message: 'Not found',
    });
  });

  it('should pass custom headers through JetStream message', async () => {
    const record = new JetstreamRecordBuilder({ id: 3 }).setHeader('x-tenant', 'beta').build();

    const result = await firstValueFrom(client.send('user.ctx', record));

    expect(result).toEqual({ id: 3, tenant: 'beta' });
  });

  it('should timeout when handler takes too long', async () => {
    const record = new JetstreamRecordBuilder({}).setTimeout(500).build();

    await expect(firstValueFrom(client.send('nonexistent.pattern', record))).rejects.toBeDefined();
  });

  it('should create command stream and consumer', async () => {
    const jsm = await nc.jetstreamManager();
    const internalName = `${serviceName}__microservice`;
    const streamInfo = await jsm.streams.info(`${internalName}_cmd-stream`);

    expect(streamInfo.config.name).toBe(`${internalName}_cmd-stream`);
    expect(streamInfo.config.subjects).toEqual([`${internalName}.cmd.>`]);
  });
});
