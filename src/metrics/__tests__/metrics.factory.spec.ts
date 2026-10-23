import * as prometheusIo from '@prometheus-io/client';
import * as promClient from 'prom-client';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_METRICS_PREFIX } from '../metrics.constants';
import { createMetrics } from '../metrics.factory';
import type { PrometheusPackage, PrometheusRuntime } from '../metrics.types';
import { loadPrometheusPackage } from '../prometheus-client';

/** A registry that can also render itself, as both packages' registries do. */
interface RenderableRegistry extends InstanceType<PrometheusRuntime['Registry']> {
  metrics(): Promise<string>;
}

const registries: Record<PrometheusPackage, () => RenderableRegistry> = {
  '@prometheus-io/client': () => new prometheusIo.Registry(),
  'prom-client': () => new promClient.Registry(),
};

describe.each(['@prometheus-io/client', 'prom-client'] as const)(
  'createMetrics with %s',
  (name) => {
    let runtime: PrometheusRuntime;
    let register: RenderableRegistry;

    beforeAll(async () => {
      const loaded = await loadPrometheusPackage(name);

      if (!loaded) throw new Error(`${name} is a dev dependency and must load`);

      runtime = loaded;
    });

    beforeEach(() => {
      register = registries[name]();
    });

    describe('happy path', () => {
      it('should create all expected metrics on the given register with default prefix', async () => {
        // Given/When
        const metrics = createMetrics({ register, runtime });

        // Then: factory returns the metric handles
        expect(metrics.messagesReceivedTotal).toBeDefined();
        expect(metrics.messagesProcessedTotal).toBeDefined();
        expect(metrics.messagesUnhandledTotal).toBeDefined();
        expect(metrics.messagesDeadLetterTotal).toBeDefined();
        expect(metrics.publishTotal).toBeDefined();
        expect(metrics.rpcTimeoutTotal).toBeDefined();
        expect(metrics.consumerRecoveredTotal).toBeDefined();
        expect(metrics.errorsTotal).toBeDefined();
        expect(metrics.handlerDurationSeconds).toBeDefined();
        expect(metrics.publishDurationSeconds).toBeDefined();
        expect(metrics.rpcDurationSeconds).toBeDefined();
        expect(metrics.consumerNumPending).toBeDefined();
        expect(metrics.consumerNumAckPending).toBeDefined();
        expect(metrics.consumerNumRedelivered).toBeDefined();
        expect(metrics.consumerNumWaiting).toBeDefined();
        expect(metrics.streamMessages).toBeDefined();
        expect(metrics.streamBytes).toBeDefined();
        expect(metrics.connectionUp).toBeDefined();
        expect(metrics.metricsPollErrorsTotal).toBeDefined();

        // And: all are registered to the supplied register with the default prefix
        const text = await register.metrics();

        expect(text).toContain(`${DEFAULT_METRICS_PREFIX}messages_received_total`);
        expect(text).toContain(`${DEFAULT_METRICS_PREFIX}handler_duration_seconds`);
        expect(text).toContain(`${DEFAULT_METRICS_PREFIX}consumer_num_pending`);
      });

      it('should honor a custom prefix', async () => {
        // Given
        createMetrics({ register, runtime, prefix: 'myapp_jet_' });

        // Then
        const text = await register.metrics();

        expect(text).toContain('myapp_jet_messages_received_total');
        expect(text).not.toContain('jetstream_messages_received_total');
      });

      it('should apply default labels to every metric', async () => {
        // Given
        const metrics = createMetrics({
          register,
          runtime,
          defaultLabels: { service: 'orders' },
        });

        // When: a counter is incremented (default labels are auto-applied)
        metrics.messagesReceivedTotal.labels({ stream: 'S', subject: 's', kind: 'event' }).inc();

        // Then: rendered output carries the default label
        const text = await register.metrics();

        expect(text).toContain('service="orders"');
      });

      it('should accept overridden histogram buckets', async () => {
        // Given/When
        const metrics = createMetrics({
          register,
          runtime,
          buckets: { handlerDuration: [0.5, 1, 5] },
        });

        // And: observe once so the client emits the bucket lines for this label set
        metrics.handlerDurationSeconds
          .labels({ stream: 'S', subject: 's', kind: 'event', status: 'ack' })
          .observe(0.1);

        // Then
        const text = await register.metrics();

        expect(text).toMatch(/jetstream_handler_duration_seconds_bucket\{[^}]*le="0\.5"/);
        // le="0.001" is a default ms-level bucket that the override must replace
        expect(text).not.toMatch(/jetstream_handler_duration_seconds_bucket\{[^}]*le="0\.001"/);
      });
    });

    describe('edge cases', () => {
      it('should not collide when called twice with different registers', () => {
        // Given/When
        const reg2 = registries[name]();

        expect(() => createMetrics({ register, runtime })).not.toThrow();
        expect(() => createMetrics({ register: reg2, runtime })).not.toThrow();
      });
    });
  },
);
