import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { NatsConnection } from 'nats';
import type { StartedTestContainer } from 'testcontainers';

import { JsonCodec } from '../../src';
import { internalName } from '../../src/jetstream.constants';

import { cleanupStreams, createNatsConnection, createTestApp, uniqueServiceName } from './helpers';
import { startNatsContainer } from './nats-container';

// ---------------------------------------------------------------------------
// Test Controllers
// ---------------------------------------------------------------------------

@Controller()
class ErrorPathRpcController {
  public callCount = 0;

  @MessagePattern('error-path.query')
  handle(): string {
    this.callCount++;

    return 'ok';
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Error Paths', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);
  });

  afterAll(async () => {
    await nc.drain();
    await container.stop();
  });

  describe('Core RPC fire-and-forget', () => {
    let serviceName: string;

    afterEach(async () => {
      await cleanupStreams(nc, serviceName);
    });

    it('should ignore fire-and-forget message and not invoke handler', async () => {
      // Given: an app with a Core RPC handler
      serviceName = uniqueServiceName();

      const { app, module } = await createTestApp({ name: serviceName, port }, [
        ErrorPathRpcController,
      ]);

      const controller = module.get(ErrorPathRpcController);

      // When: publish to the RPC subject WITHOUT a reply subject
      const subject = `${internalName(serviceName)}.cmd.error-path.query`;
      const codec = new JsonCodec();

      nc.publish(subject, codec.encode({ test: true }));

      // Wait for any potential handler invocation
      await new Promise((r) => setTimeout(r, 1_000));

      // Then: handler was NOT invoked
      expect(controller.callCount).toBe(0);

      // And: app closes without throwing
      await expect(app.close()).resolves.not.toThrow();
    });
  });
});
