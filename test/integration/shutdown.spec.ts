import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { NatsConnection } from 'nats';

import { JETSTREAM_CONNECTION } from '../../src';
import { ConnectionProvider } from '../../src/connection';

import { cleanupStreams, createNatsConnection, createTestApp, uniqueServiceName } from './helpers';

// ---------------------------------------------------------------------------
// Test Controllers
// ---------------------------------------------------------------------------

@Controller()
class ShutdownEventController {
  @EventPattern('order.created')
  handleOrder(@Payload() _data: unknown): void {}
}

@Controller()
class ShutdownRpcController {
  @MessagePattern('user.get')
  getUser(): { id: number } {
    return { id: 1 };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Graceful Shutdown', () => {
  let nc: NatsConnection;

  beforeAll(async () => {
    nc = await createNatsConnection();
  });

  afterAll(async () => {
    await nc.drain();
  });

  it('should drain NATS connection on app.close()', async () => {
    const serviceName = uniqueServiceName();
    const { app, module } = await createTestApp({ name: serviceName }, [ShutdownEventController]);

    try {
      const connection = module.get<ConnectionProvider>(JETSTREAM_CONNECTION);

      // Connection should be active before close
      expect(connection.unwrap).not.toBeNull();

      await app.close();

      // After close, connection should be cleaned up
      expect(connection.unwrap).toBeNull();
    } finally {
      await cleanupStreams(nc, serviceName);
    }
  });

  it('should not create streams when no handlers registered', async () => {
    const serviceName = uniqueServiceName();
    const { app } = await createTestApp(
      { name: serviceName },
      [], // no controllers
    );

    try {
      const jsm = await nc.jetstreamManager();
      const internalName = `${serviceName}__microservice`;

      // No event stream should exist
      await expect(jsm.streams.info(`${internalName}_ev-stream`)).rejects.toThrow();

      // No command stream should exist
      await expect(jsm.streams.info(`${internalName}_cmd-stream`)).rejects.toThrow();
    } finally {
      await app.close();
      await cleanupStreams(nc, serviceName);
    }
  });

  it('should close cleanly with both event and RPC handlers', async () => {
    const serviceName = uniqueServiceName();
    const { app, module } = await createTestApp({ name: serviceName }, [
      ShutdownEventController,
      ShutdownRpcController,
    ]);

    try {
      const connection = module.get<ConnectionProvider>(JETSTREAM_CONNECTION);

      // Should be connected
      expect(connection.unwrap).not.toBeNull();

      // Close should not throw
      await app.close();

      // Connection drained
      expect(connection.unwrap).toBeNull();
    } finally {
      await cleanupStreams(nc, serviceName);
    }
  });
});
