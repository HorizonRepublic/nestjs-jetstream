import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import { NatsConnection } from 'nats';
import { firstValueFrom } from 'rxjs';

import { getClientToken } from '../../src';
import type { Codec } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';

// ---------------------------------------------------------------------------
// Custom test codec: Base64-encoded JSON
// Proves the codec is actually used end-to-end (not just the default JSON).
// ---------------------------------------------------------------------------

class Base64JsonCodec implements Codec {
  encode(data: unknown): Uint8Array {
    const json = JSON.stringify(data);
    const base64 = Buffer.from(json).toString('base64');
    return new TextEncoder().encode(base64);
  }

  decode(data: Uint8Array): unknown {
    const base64 = new TextDecoder().decode(data);
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json);
  }
}

// ---------------------------------------------------------------------------
// Test Controllers
// ---------------------------------------------------------------------------

@Controller()
class CodecRpcController {
  @MessagePattern('echo')
  echo(@Payload() data: unknown): unknown {
    return data;
  }
}

@Controller()
class CodecEventController {
  public readonly received: unknown[] = [];

  @EventPattern('item.created')
  handle(@Payload() data: unknown): void {
    this.received.push(data);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Codec Round-Trip', () => {
  let nc: NatsConnection;

  beforeAll(async () => {
    nc = await createNatsConnection();
  });

  afterAll(async () => {
    await nc.drain();
  });

  describe('global codec (forRoot)', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;

    beforeEach(async () => {
      serviceName = uniqueServiceName();

      ({ app, module } = await createTestApp(
        { name: serviceName, codec: new Base64JsonCodec() },
        [CodecRpcController, CodecEventController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should encode and decode RPC with custom codec', async () => {
      const payload = { nested: { value: 42 }, list: [1, 2, 3] };

      const result = await firstValueFrom(client.send('echo', payload));

      expect(result).toEqual(payload);
    });

    it('should encode and decode events with custom codec', async () => {
      const controller = module.get(CodecEventController);
      const payload = { name: 'Widget', price: 9.99 };

      await firstValueFrom(client.emit('item.created', payload));

      await waitForCondition(() => controller.received.length > 0, 5_000);

      expect(controller.received[0]).toEqual(payload);
    });
  });
});
