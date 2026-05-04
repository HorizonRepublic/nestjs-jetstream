import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from 'prom-client';

import { createMetrics } from '../metrics.factory';
import { DEFAULT_METRICS_PREFIX } from '../metrics.constants';

describe(createMetrics, () => {
  let register: Registry;

  beforeEach(() => {
    register = new Registry();
  });

  describe('happy path', () => {
    it('should create all expected metrics on the given register with default prefix', async () => {
      // Given/When
      const metrics = createMetrics({ register });

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
      createMetrics({ register, prefix: 'myapp_jet_' });

      // Then
      const text = await register.metrics();

      expect(text).toContain('myapp_jet_messages_received_total');
      expect(text).not.toContain('jetstream_messages_received_total');
    });

    it('should apply default labels to every metric', async () => {
      // Given
      const metrics = createMetrics({ register, defaultLabels: { service: 'orders' } });

      // When: a counter is incremented (default labels are auto-applied)
      metrics.messagesReceivedTotal.inc({ stream: 'S', subject: 's', kind: 'event' });

      // Then: rendered output carries the default label
      const text = await register.metrics();

      expect(text).toContain('service="orders"');
    });

    it('should accept overridden histogram buckets', async () => {
      // Given/When
      const metrics = createMetrics({
        register,
        buckets: { handlerDuration: [0.5, 1, 5] },
      });

      // And: observe once so prom-client emits the bucket lines for this label set
      metrics.handlerDurationSeconds.observe(
        { stream: 'S', subject: 's', kind: 'event', status: 'ack' },
        0.1,
      );

      // Then
      const text = await register.metrics();

      // Custom bucket boundary should appear
      expect(text).toMatch(/jetstream_handler_duration_seconds_bucket\{[^}]*le="0\.5"/);
      // Default ms-level bucket should NOT appear
      expect(text).not.toMatch(/jetstream_handler_duration_seconds_bucket\{[^}]*le="0\.001"/);
    });
  });

  describe('edge cases', () => {
    it('should not collide when called twice with different registers', () => {
      // Given/When
      const reg2 = new Registry();

      expect(() => createMetrics({ register })).not.toThrow();
      expect(() => createMetrics({ register: reg2 })).not.toThrow();
    });
  });
});
