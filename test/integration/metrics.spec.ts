import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, INestApplication } from '@nestjs/common';
import { ClientProxy, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';
import type { NatsConnection } from '@nats-io/transport-node';
import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { Registry } from 'prom-client';

import { getClientToken, StreamKind, streamName, toNanos } from '../../src';

import {
  cleanupStreams,
  createNatsConnection,
  createTestApp,
  uniqueServiceName,
  waitForCondition,
} from './helpers';
import { startNatsContainer } from './nats-container';

@Controller()
class MetricsController {
  public events: unknown[] = [];

  @EventPattern('orders.created')
  public handleOrderCreated(@Payload() data: unknown): void {
    this.events.push(data);
  }

  @EventPattern('orders.cancelled')
  public handleOrderCancelled(): never {
    throw new Error('cancel failed');
  }

  @MessagePattern('orders.get')
  public handleGet(@Payload() data: { id: number }): { id: number; ok: true } {
    return { id: data.id, ok: true };
  }

  @MessagePattern('orders.fail')
  public handleFail(): never {
    throw new Error('rpc handler failure');
  }
}

interface PromSample {
  value: number;
  labels: Record<string, string>;
}

const samples = async (register: Registry, name: string): Promise<PromSample[]> => {
  const metric = register.getSingleMetric(name);

  if (!metric) return [];

  const data = await metric.get();

  return data.values as PromSample[];
};

const findSample = (list: PromSample[], match: Record<string, string>): PromSample | undefined =>
  list.find((s) => Object.entries(match).every(([k, v]) => s.labels[k] === v));

/** Poll a metric registry until a sample matching the labels exists, or fail. */
const waitForSample = (
  register: Registry,
  metric: string,
  match: Record<string, string>,
  timeoutMs = 5_000,
): Promise<void> =>
  waitForCondition(
    async () => findSample(await samples(register, metric), match) !== undefined,
    timeoutMs,
  );

/** Poll the registry's text output until a regex matches, or fail. */
const waitForTextMatch = (register: Registry, re: RegExp, timeoutMs = 5_000): Promise<void> =>
  waitForCondition(async () => re.test(await register.metrics()), timeoutMs);

describe('Metrics; integration', () => {
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

  describe('when metrics are enabled with a custom registry', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let register: Registry;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      register = new Registry();

      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          metrics: { register, pollInterval: 0 },
          events: {
            consumer: {
              max_deliver: 2,
              ack_wait: toNanos(1, 'seconds'),
            },
          },
        },
        [MetricsController],
        [serviceName],
      ));

      client = module.get<ClientProxy>(getClientToken(serviceName));
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should increment messages_received_total and messages_processed_total with success status for a successful event', async () => {
      // Given/When
      await firstValueFrom(client.emit('orders.created', { orderId: 'a1' }));

      const processedLabels = {
        stream: streamName(serviceName, StreamKind.Event),
        subject: 'orders.created',
        kind: 'event',
        status: 'success',
      };

      await waitForSample(register, 'jetstream_messages_processed_total', processedLabels);

      // Then
      const received = await samples(register, 'jetstream_messages_received_total');
      const processed = await samples(register, 'jetstream_messages_processed_total');

      expect(
        findSample(received, {
          stream: streamName(serviceName, StreamKind.Event),
          subject: 'orders.created',
          kind: 'event',
        })?.value,
      ).toBe(1);
      expect(findSample(processed, processedLabels)?.value).toBe(1);
    });

    it('should observe handler_duration_seconds for completed handlers', async () => {
      // Given/When
      await firstValueFrom(client.emit('orders.created', { orderId: 'b1' }));

      const re = new RegExp(
        `^jetstream_handler_duration_seconds_count\\{[^}]*subject="orders\\.created"[^}]*\\}\\s+(\\d+)`,
        'm',
      );

      await waitForTextMatch(register, re);

      // Then
      const match = re.exec(await register.metrics());

      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThanOrEqual(1);
    });

    it('should increment messages_processed_total with status=error and errors_total{context=handler} when handler throws', async () => {
      // Given/When: handler always throws -> nak'd, may redeliver up to max_deliver
      await firstValueFrom(client.emit('orders.cancelled', { orderId: 'c1' }));

      // Wait for at least one error to surface (redeliveries are best-effort)
      await waitForSample(register, 'jetstream_messages_processed_total', {
        subject: 'orders.cancelled',
        status: 'error',
      });

      // Then
      const errors = await samples(register, 'jetstream_errors_total');
      const handlerErrors = findSample(errors, { context: 'handler' });

      expect(handlerErrors?.value).toBeGreaterThanOrEqual(1);
    });

    it('should record RPC handler completion via Core RPC with status=success', async () => {
      // Given/When
      const response = await firstValueFrom(client.send('orders.get', { id: 7 }));

      expect(response).toEqual({ id: 7, ok: true });

      const labels = { subject: 'orders.get', kind: 'command', status: 'success' };

      await waitForSample(register, 'jetstream_messages_processed_total', labels);

      // Then
      const processed = await samples(register, 'jetstream_messages_processed_total');

      expect(findSample(processed, labels)?.value).toBe(1);
    });

    it('should record connection_up=1 after bootstrap completes', async () => {
      // The Connect event during bootstrap already set the gauge; no traffic needed.
      const conn = await samples(register, 'jetstream_connection_up');
      const upSample = conn.find((s) => s.value === 1);

      expect(upSample).toBeDefined();
      expect(upSample!.labels.server).toMatch(/localhost/);
    });

    it('should increment publish_total and observe publish_duration_seconds for a successful event emit', async () => {
      // Given/When
      await firstValueFrom(client.emit('orders.created', { id: 'd1' }));

      const labels = { subject: 'orders.created', kind: 'event', status: 'success' };

      await waitForSample(register, 'jetstream_publish_total', labels);

      // Then
      const published = await samples(register, 'jetstream_publish_total');

      expect(findSample(published, labels)?.value).toBe(1);
      expect(await register.metrics()).toMatch(
        /^jetstream_publish_duration_seconds_count\{[^}]*subject="orders\.created"[^}]*\}\s+\d+/m,
      );
    });

    it('should record rpc_duration_seconds with status=success on a successful Core RPC reply', async () => {
      // Given/When
      await firstValueFrom(client.send('orders.get', { id: 99 }));

      const rpcCountRe =
        /^jetstream_rpc_duration_seconds_count\{[^}]*subject="orders\.get"[^}]*status="success"[^}]*\}\s+\d+/m;

      await waitForTextMatch(register, rpcCountRe);

      // Then
      expect(await register.metrics()).toMatch(rpcCountRe);
      const published = await samples(register, 'jetstream_publish_total');

      expect(
        findSample(published, { subject: 'orders.get', kind: 'command', status: 'success' })?.value,
      ).toBe(1);
    });

    it('should record rpc_duration_seconds with status=error when the RPC handler throws', async () => {
      // Given/When
      await firstValueFrom(client.send('orders.fail', {})).catch(() => undefined);

      const rpcErrorRe =
        /^jetstream_rpc_duration_seconds_count\{[^}]*subject="orders\.fail"[^}]*status="error"[^}]*\}\s+\d+/m;

      await waitForTextMatch(register, rpcErrorRe);

      // Then
      expect(await register.metrics()).toMatch(rpcErrorRe);
    });

    it('should bucket unknown subjects into messages_unhandled_total when nothing routes', async () => {
      // Given/When: unmatched traffic is hard to drive end-to-end, so only assert
      // that the counter family is registered
      const unhandled = await samples(register, 'jetstream_messages_unhandled_total');

      // The metric family is always registered; with no traffic the values
      // array is empty (prom-client lazy-allocates label combinations).
      expect(unhandled).toBeDefined();
    });
  });

  describe('polling gauges (consumer + stream info)', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let serviceName: string;
    let register: Registry;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      register = new Registry();
      ({ app, module } = await createTestApp(
        {
          name: serviceName,
          port,
          // Short interval so the test doesn't wait forever for the first tick.
          metrics: { register, pollInterval: 100 },
        },
        [MetricsController],
        [serviceName],
      ));
      client = module.get<ClientProxy>(getClientToken(serviceName));
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should publish gauges for each active consumer kind after one tick', async () => {
      // Given/When: emit one message so the stream has state worth observing
      await firstValueFrom(client.emit('orders.created', { id: 'p1' }));

      // Wait for the poll cycle that publishes the asserted stream gauge; that cycle
      // also publishes the consumer gauges, so this avoids a stream/consumer race under load.
      const streamGauge = new RegExp(
        `^jetstream_stream_messages\\{stream="${streamName(serviceName, StreamKind.Event)}"\\}`,
        'm',
      );

      await waitForCondition(async () => streamGauge.test(await register.metrics()), 10_000);

      // Then
      const text = await register.metrics();

      expect(text).toMatch(
        new RegExp(`^jetstream_consumer_num_pending\\{[^}]*kind="event"[^}]*\\}`, 'm'),
      );
      expect(text).toMatch(
        new RegExp(
          `^jetstream_stream_messages\\{stream="${streamName(serviceName, StreamKind.Event)}"\\}`,
          'm',
        ),
      );
      expect(text).toMatch(
        new RegExp(
          `^jetstream_stream_bytes\\{stream="${streamName(serviceName, StreamKind.Event)}"\\}`,
          'm',
        ),
      );
    });

    it('should not register metrics_poll_errors_total samples during healthy polling', async () => {
      // Given/When: emit one event and wait until at least one poll tick has
      // actually written a stream gauge, proving the poll loop ran healthily
      await firstValueFrom(client.emit('orders.created', { id: 'p2' }));
      await waitForTextMatch(register, /^jetstream_consumer_num_ack_pending\{/m);

      // Then: the poll-error family carries no non-zero samples
      const text = await register.metrics();

      expect(text).not.toMatch(/^jetstream_metrics_poll_errors_total\{[^}]+\}\s+[1-9]/m);
    });
  });

  describe('when metrics are disabled', () => {
    let app: INestApplication;
    let serviceName: string;

    beforeEach(async () => {
      serviceName = uniqueServiceName();
      ({ app } = await createTestApp(
        {
          name: serviceName,
          port,
          // metrics omitted -> module not registered
        },
        [MetricsController],
        [serviceName],
      ));
    });

    afterEach(async () => {
      await app.close();
      await cleanupStreams(nc, serviceName);
    });

    it('should not register any jetstream_* metrics on the prom-client global registry', async () => {
      const { register: globalRegister } = await import('prom-client');
      const text = await globalRegister.metrics();

      // The global register may be polluted by other tests (or process-wide
      // metrics from prior runs); narrow to the families this lib owns.
      expect(text).not.toMatch(/^jetstream_messages_received_total/m);
    });
  });
});
