import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JetstreamConnection, ManagementMode } from '../../src';
import { createMultiConnectionApp, uniqueServiceName } from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class PrimaryController {
  @EventPattern('collision.primary')
  public onPrimary(@Payload() _data: unknown): void {}
}

@JetstreamConnection('clone')
@Controller()
class CloneController {
  @EventPattern('collision.clone')
  public onClone(@Payload() _data: unknown): void {}
}

describe('multi-connection collision detection', () => {
  let container: StartedTestContainer;
  let port: number;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
  });

  afterAll(async () => {
    await container.stop();
  });

  it('should reject two connections declaring an identical server set', async () => {
    // Given two connections pointing at the same URL, before any network call
    // When the module is registered, Then it fails fast naming both
    await expect(
      createMultiConnectionApp({
        name: uniqueServiceName(),
        connections: {
          primary: { servers: [`nats://localhost:${port}`] },
          clone: { servers: [`nats://localhost:${port}`] },
        },
        defaultConnection: 'primary',
        controllers: [PrimaryController, CloneController],
      }),
    ).rejects.toThrow(/same NATS cluster/);
  });

  it('should reject two connections reaching one cluster under different URLs', async () => {
    // Given the same cluster addressed as localhost and 127.0.0.1, which the
    // config sieve cannot see through
    // When the app boots, Then the stream ownership stamp catches it
    await expect(
      createMultiConnectionApp({
        name: uniqueServiceName(),
        connections: {
          primary: { servers: [`nats://localhost:${port}`] },
          clone: { servers: [`nats://127.0.0.1:${port}`] },
        },
        defaultConnection: 'primary',
        controllers: [PrimaryController, CloneController],
      }),
    ).rejects.toThrow(/already owned by connection/);
  }, 60_000);

  it('should not stamp or check ownership under Manual management', async () => {
    // Given externally managed streams on one shared cluster
    const serviceName = uniqueServiceName();

    // When the app boots with both connections bound rather than provisioning,
    // Then the ownership sieve is disabled and boot proceeds
    const { app } = await createMultiConnectionApp({
      name: serviceName,
      root: { provisioning: { management: ManagementMode.Manual } },
      connections: {
        primary: { servers: [`nats://localhost:${port}`] },
        clone: { servers: [`nats://127.0.0.1:${port}`] },
      },
      defaultConnection: 'primary',
      controllers: [],
    });

    expect(app).toBeDefined();
    await app.close();
  }, 60_000);
});
