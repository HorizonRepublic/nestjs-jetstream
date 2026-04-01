import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '@nats-io/transport-node';
import { jetstreamManager } from '@nats-io/jetstream';
import type { StartedTestContainer } from 'testcontainers';

import { startNatsContainer } from './nats-container';

describe('NATS connectivity', () => {
  let container: StartedTestContainer;
  let port: number;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
  });

  afterAll(async () => {
    await container.stop();
  });

  it('should connect to NATS server', async () => {
    const nc = await connect({ servers: [`nats://localhost:${port}`] });

    expect(nc.getServer()).toContain('localhost');
    await nc.drain();
  });

  it('should have JetStream enabled', async () => {
    const nc = await connect({ servers: [`nats://localhost:${port}`] });
    const jsm = await jetstreamManager(nc);
    const info = await jsm.getAccountInfo();

    expect(info).toBeDefined();
    await nc.drain();
  });
});
