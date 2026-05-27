import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

import { EventBus } from '../../hooks';
import { TransportEvent } from '../../interfaces';

import { DEFAULT_POLL_INTERVAL_MS } from '../metrics.constants';
import type { PromClientRuntime } from '../metrics.factory';
import { JetstreamMetricsService } from '../metrics.service';

describe(JetstreamMetricsService, () => {
  let sut: JetstreamMetricsService;
  let eventBus: Mocked<EventBus>;
  let register: Registry;
  let promClient: PromClientRuntime;

  beforeEach(() => {
    eventBus = createMock<EventBus>();
    register = new Registry();
    promClient = { Counter, Histogram, Gauge };
  });

  afterEach(() => {
    vi.resetAllMocks();
    register.clear();
  });

  describe('happy path', () => {
    beforeEach(() => {
      sut = new JetstreamMetricsService(eventBus, { register, pollInterval: 0 }, promClient);
    });

    it('should subscribe to every transport event consumed by the metrics service on bootstrap', async () => {
      // When
      await sut.onApplicationBootstrap();

      // Then
      const subscribedEvents = eventBus.subscribe.mock.calls.map(([event]) => event);

      expect(subscribedEvents).toEqual(
        expect.arrayContaining([
          TransportEvent.Connect,
          TransportEvent.Disconnect,
          TransportEvent.Reconnect,
          TransportEvent.Error,
          TransportEvent.RpcTimeout,
          TransportEvent.MessageRouted,
          TransportEvent.DeadLetter,
          TransportEvent.ConsumerRecovered,
          TransportEvent.HandlerCompleted,
        ]),
      );
    });

    it('should register every Jetstream metric family on the configured prom-client registry', async () => {
      // When
      await sut.onApplicationBootstrap();

      // Then
      const text = await register.metrics();

      expect(text).toContain('jetstream_messages_received_total');
      expect(text).toContain('jetstream_handler_duration_seconds');
      expect(text).toContain('jetstream_consumer_num_pending');
      expect(text).toContain('jetstream_metrics_poll_errors_total');
    });

    it('should honor the configured prefix when instantiating metrics', async () => {
      // Given
      sut = new JetstreamMetricsService(
        eventBus,
        { register, prefix: 'svc_', pollInterval: 0 },
        promClient,
      );

      // When
      await sut.onApplicationBootstrap();

      // Then
      const text = await register.metrics();

      expect(text).toContain('svc_messages_received_total');
      expect(text).not.toContain('jetstream_messages_received_total');
    });
  });

  describe('edge cases', () => {
    it('should default pollInterval to 15s when not provided', () => {
      // Given/When
      sut = new JetstreamMetricsService(eventBus, { register }, promClient);

      // Then
      expect(sut.getEffectivePollInterval()).toBe(DEFAULT_POLL_INTERVAL_MS);
    });

    it('should treat pollInterval=0 as polling disabled', () => {
      // Given/When
      sut = new JetstreamMetricsService(eventBus, { register, pollInterval: 0 }, promClient);

      // Then
      expect(sut.getEffectivePollInterval()).toBe(0);
    });

    it('should be idempotent across multiple bootstrap calls', async () => {
      // Given
      sut = new JetstreamMetricsService(eventBus, { register, pollInterval: 0 }, promClient);

      // When
      await sut.onApplicationBootstrap();

      // Then: second bootstrap must not throw nor re-register metrics
      await expect(sut.onApplicationBootstrap()).resolves.not.toThrow();
    });
  });
});
