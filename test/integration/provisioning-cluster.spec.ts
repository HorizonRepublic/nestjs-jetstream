import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller } from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';

import { JetstreamProvisioningError, NatsErrorCode } from '../../src';

import { createTestApp, uniqueServiceName } from './helpers';
import { startNatsCluster, type NatsClusterResult } from './nats-container';

@Controller()
class ClusterProvisioningController {
  @EventPattern('order.created')
  handleOrder(): void {}
}

describe('Provisioning error on a clustered NATS', () => {
  let cluster: NatsClusterResult | undefined;

  beforeAll(async () => {
    // 3 nodes, each capped to 1 MiB file store: no peer can hold the default
    // 5 GiB event stream with num_replicas: 3 → "no suitable peers for placement".
    cluster = await startNatsCluster({ nodes: 3, maxFileStoreBytes: 1024 * 1024 });
  }, 180_000);

  afterAll(async () => {
    await cluster?.stop();
  });

  it('should wrap the no-suitable-peers placement failure as JetstreamProvisioningError', async () => {
    // Given: a replicated event stream that no peer has storage to place
    const serviceName = uniqueServiceName();

    // When: bootstrapping the microservice provisions the stream
    let captured: unknown;

    try {
      const { app } = await createTestApp(
        { name: serviceName, port: cluster!.port, events: { stream: { num_replicas: 3 } } },
        [ClusterProvisioningController],
      );

      await app.close();
    } catch (err) {
      captured = err;
    }

    // Then: a real cluster returns 10005, distinct from a single node's 10074
    expect(captured).toBeInstanceOf(JetstreamProvisioningError);

    const provisioningErr = captured as JetstreamProvisioningError;

    expect(provisioningErr.entity).toBe('stream');
    expect(provisioningErr.errCode).toBe(NatsErrorCode.NoSuitablePeers);
    expect(provisioningErr.errCode).toBe(10005);
    expect(provisioningErr.message).toContain('no suitable peers for placement');
  }, 120_000);
});
