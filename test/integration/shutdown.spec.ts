import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import type { NatsConnection } from '@nats-io/transport-node';
import { jetstreamManager } from '@nats-io/jetstream';
import type { StartedTestContainer } from 'testcontainers';

import { JETSTREAM_CONNECTION } from '../../src';
import { ConnectionProvider } from '../../src/connection';

import { cleanupStreams, createNatsConnection, createTestApp, uniqueServiceName } from './helpers';
import {
  restartNatsContainer,
  startNatsContainer,
  startNatsContainerWithFixedPort,
} from './nats-container';

// Fixed port for the shutdown-during-reconnect test — must survive container.restart()
const SHUTDOWN_RECONNECT_PORT = 14_223;

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

describe('Graceful Shutdown', () => {
  let nc: NatsConnection;
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

  it('should drain NATS connection on app.close()', async () => {
    const serviceName = uniqueServiceName();
    const { app, module } = await createTestApp({ name: serviceName, port }, [
      ShutdownEventController,
    ]);

    try {
      const connection = module.get<ConnectionProvider>(JETSTREAM_CONNECTION);

      // Connection should be active before close
      expect(connection.unwrap).not.toBeNull();

      await app.close();

      // After close, connection should be cleaned up
      expect(connection.unwrap).toBeNull();
    } finally {
      await app.close().catch(() => {});
      await cleanupStreams(nc, serviceName);
    }
  });

  it('should not create streams when no handlers registered', async () => {
    const serviceName = uniqueServiceName();
    const { app } = await createTestApp(
      { name: serviceName, port },
      [], // no controllers
    );

    try {
      const jsm = await jetstreamManager(nc);
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
    const { app, module } = await createTestApp({ name: serviceName, port }, [
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
      await app.close().catch(() => {});
      await cleanupStreams(nc, serviceName);
    }
  });

  describe('shutdown during reconnection', () => {
    let reconnectContainer: StartedTestContainer;
    let reconnectPort: number;

    beforeAll(async () => {
      ({ container: reconnectContainer, port: reconnectPort } =
        await startNatsContainerWithFixedPort(SHUTDOWN_RECONNECT_PORT));
    });

    afterAll(async () => {
      await reconnectContainer.stop();
    });

    it('should close cleanly while transport is reconnecting', { timeout: 60_000 }, async () => {
      const serviceName = uniqueServiceName();
      const { app } = await createTestApp({ name: serviceName, port: reconnectPort }, [
        ShutdownEventController,
      ]);

      // Restart NATS — transport enters reconnection state
      await restartNatsContainer(reconnectContainer);

      // Close app during reconnection — should not throw or hang
      await app.close();
    });
  });
});
