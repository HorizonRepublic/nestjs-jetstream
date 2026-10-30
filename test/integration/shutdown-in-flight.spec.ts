import { Controller } from '@nestjs/common';
import { ClientProxy, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

import { jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { consumerName, getClientToken, StreamKind, streamName } from '../../src';
import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

const HANDLER_DURATION_MS = 1_500;

interface HandlerProbe {
  started: number;
  finished: number;
}

const probe: HandlerProbe = { started: 0, finished: 0 };

const runSlowly = async <T>(result: T): Promise<T> => {
  probe.started += 1;
  await new Promise((resolve) => setTimeout(resolve, HANDLER_DURATION_MS));
  probe.finished += 1;

  return result;
};

@Controller()
class SlowEventController {
  @EventPattern('report.build')
  async build(@Payload() _data: unknown): Promise<void> {
    await runSlowly(undefined);
  }
}

@Controller()
class SlowCommandController {
  @MessagePattern('invoice.issue')
  async issue(@Payload() data: { id: number }): Promise<{ issued: number }> {
    return runSlowly({ issued: data.id });
  }
}

describe('Graceful shutdown with handlers in flight', () => {
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

  beforeEach(() => {
    probe.started = 0;
    probe.finished = 0;
  });

  it('should let an in-flight event handler finish and ack before the connection drains', async () => {
    // Given a service whose event handler is mid-execution
    const serviceName = uniqueServiceName();
    const server = await createTestApp({ name: serviceName, port }, [SlowEventController]);
    const caller = await createTestApp(
      { name: uniqueServiceName(), port, publisherOnly: true },
      [],
      [serviceName],
    );

    try {
      const client = caller.module.get<ClientProxy>(getClientToken(serviceName));

      await firstValueFrom(client.emit('report.build', { id: 1 }), { defaultValue: undefined });
      await waitForCondition(() => probe.started === 1, 5_000);

      // When the service shuts down
      await server.app.close();

      // Then the handler ran to completion and its ack reached the server
      expect(probe.finished).toBe(1);

      const jsm = await jetstreamManager(nc);
      const info = await jsm.consumers.info(
        streamName(serviceName, StreamKind.Event),
        consumerName(serviceName, StreamKind.Event),
      );

      expect(info.num_ack_pending).toBe(0);
      expect(info.num_redelivered).toBe(0);
      expect(info.ack_floor.stream_seq).toBe(1);
    } finally {
      await server.app.close().catch(() => {});
      await caller.app.close();
      await cleanupStreams(nc, serviceName);
    }
  });

  it('should reply to a JetStream RPC command that was in flight at shutdown', async () => {
    // Given a JetStream-mode service whose command handler is mid-execution
    const serviceName = uniqueServiceName();
    const rpc = { mode: 'jetstream', timeout: 10_000 } as const;
    const server = await createTestApp({ name: serviceName, port, rpc }, [SlowCommandController]);
    const caller = await createTestApp(
      { name: uniqueServiceName(), port, rpc, publisherOnly: true },
      [],
      [serviceName],
    );

    try {
      const client = caller.module.get<ClientProxy>(getClientToken(serviceName));
      const reply = firstValueFrom(client.send('invoice.issue', { id: 42 }));

      await waitForCondition(() => probe.started === 1, 5_000);

      // When the service shuts down
      await server.app.close();

      // Then the caller still receives the reply
      await expect(reply).resolves.toEqual({ issued: 42 });
      expect(probe.finished).toBe(1);
    } finally {
      await server.app.close().catch(() => {});
      await caller.app.close();
      await cleanupStreams(nc, serviceName);
    }
  });
});
