import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { faker } from '@faker-js/faker';

import { EventBus } from '../../hooks';
import type {
  DeadLetterInfo,
  JetstreamModuleOptions,
  PublishStatus,
  RpcOutcomeStatus,
} from '../../interfaces';
import { MessageKind, StreamKind, TransportEvent } from '../../interfaces';
import { streamName } from '../../jetstream.constants';
import { PatternRegistry } from '../../server/routing/pattern-registry';

import { DEFAULT_POLL_INTERVAL_MS, UNMATCHED_SUBJECT_LABEL } from '../metrics.constants';
import { JetstreamMetricsService } from '../metrics.service';
import type { PromClientRuntime } from '../metrics.types';

type Subscribers = Map<string, ((...args: unknown[]) => void)[]>;

/**
 * Capture every `subscribe()` call into a map keyed by event name so tests can
 * invoke the metrics service's handlers directly. Mirrors the real EventBus
 * dispatching contract closely enough for label/value assertions.
 */
const captureSubscribers = (eventBus: Mocked<EventBus>): Subscribers => {
  const subs: Subscribers = new Map();

  eventBus.subscribe.mockImplementation(((event: string, handler: (...a: unknown[]) => void) => {
    const list = subs.get(event) ?? [];

    list.push(handler);
    subs.set(event, list);
  }) as typeof eventBus.subscribe);

  return subs;
};

const dispatch = (subs: Subscribers, event: TransportEvent, ...args: unknown[]): void => {
  for (const handler of subs.get(event) ?? []) handler(...args);
};

const sampleValue = async (
  register: Registry,
  metricName: string,
  matchLabels: Record<string, string>,
): Promise<number | undefined> => {
  const m = await register.getSingleMetric(metricName)?.get();

  if (!m || !('values' in m)) return undefined;

  const sample = m.values.find((v) =>
    Object.entries(matchLabels).every(
      ([k, val]) => (v.labels as Record<string, unknown>)[k] === val,
    ),
  );

  return sample?.value;
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const histogramCount = async (
  register: Registry,
  metricName: string,
  matchLabels: Record<string, string>,
): Promise<number | undefined> => {
  const text = await register.metrics();
  const labelExpr = Object.entries(matchLabels)
    .map(([k, v]) => `${escapeRegex(k)}="${escapeRegex(v)}"`)
    .join(',');
  // The `_count` suffix is appended by prom-client when rendering histograms;
  // we parse it from the text exposition to avoid the typed-API churn around
  // histogram bucket samples (rich metric object reshapes across versions).
  const re = new RegExp(
    `^${escapeRegex(metricName)}_count\\{[^}]*${labelExpr}[^}]*\\}\\s+(\\d+)`,
    'm',
  );
  const match = re.exec(text);

  return match ? Number(match[1]) : undefined;
};

const setup = async (params: {
  options: JetstreamModuleOptions;
  patternRegistry?: PatternRegistry | null;
  register: Registry;
  promClient: PromClientRuntime;
  eventBus: Mocked<EventBus>;
}): Promise<{ sut: JetstreamMetricsService; subs: Subscribers }> => {
  const subs = captureSubscribers(params.eventBus);

  const sut = new JetstreamMetricsService(
    params.eventBus,
    { register: params.register, pollInterval: 0 },
    params.promClient,
    params.options,
    params.patternRegistry ?? null,
  );

  await sut.onApplicationBootstrap();

  return { sut, subs };
};

describe(JetstreamMetricsService, () => {
  let eventBus: Mocked<EventBus>;
  let register: Registry;
  let promClient: PromClientRuntime;
  let options: JetstreamModuleOptions;

  beforeEach(() => {
    eventBus = createMock<EventBus>();
    register = new Registry();
    promClient = { Counter, Histogram, Gauge };
    options = { name: 'orders', servers: ['nats://localhost:4222'] };
  });

  afterEach(() => {
    vi.resetAllMocks();
    register.clear();
  });

  describe('bootstrap', () => {
    it('should subscribe to every transport event consumed by the metrics service', async () => {
      // Given/When
      const { subs } = await setup({ options, register, promClient, eventBus });

      // Then
      expect([...subs.keys()]).toEqual(
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
          TransportEvent.Published,
          TransportEvent.RpcCompleted,
        ]),
      );
    });

    it('should register every Jetstream metric family on the configured registry', async () => {
      // Given/When
      await setup({ options, register, promClient, eventBus });

      // Then
      const text = await register.metrics();

      expect(text).toContain('jetstream_messages_received_total');
      expect(text).toContain('jetstream_handler_duration_seconds');
      expect(text).toContain('jetstream_consumer_num_pending');
      expect(text).toContain('jetstream_metrics_poll_errors_total');
    });

    it('should honor the configured prefix', async () => {
      // Given
      captureSubscribers(eventBus);
      const sut = new JetstreamMetricsService(
        eventBus,
        { register, pollInterval: 0, prefix: 'svc_' },
        promClient,
        options,
        null,
      );

      // When
      await sut.onApplicationBootstrap();

      // Then
      const text = await register.metrics();

      expect(text).toContain('svc_messages_received_total');
      expect(text).not.toContain('jetstream_messages_received_total');
    });

    it('should be idempotent across multiple bootstrap calls', async () => {
      // Given
      captureSubscribers(eventBus);
      const sut = new JetstreamMetricsService(
        eventBus,
        { register, pollInterval: 0 },
        promClient,
        options,
        null,
      );

      await sut.onApplicationBootstrap();

      // Then
      await expect(sut.onApplicationBootstrap()).resolves.not.toThrow();
    });
  });

  describe('Connect/Disconnect/Reconnect → connection_up gauge', () => {
    it('should flip connection_up to 1 on Connect for the given server', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });
      const server = faker.internet.url();

      // When
      dispatch(subs, TransportEvent.Connect, server);

      // Then
      expect(await sampleValue(register, 'jetstream_connection_up', { server })).toBe(1);
    });

    it('should flip connection_up to 0 on Disconnect for every observed server', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });
      const serverA = faker.internet.url();
      const serverB = faker.internet.url();

      dispatch(subs, TransportEvent.Connect, serverA);
      dispatch(subs, TransportEvent.Connect, serverB);

      // When
      dispatch(subs, TransportEvent.Disconnect);

      // Then
      expect(await sampleValue(register, 'jetstream_connection_up', { server: serverA })).toBe(0);
      expect(await sampleValue(register, 'jetstream_connection_up', { server: serverB })).toBe(0);
    });

    it('should flip connection_up back to 1 on Reconnect', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });
      const server = faker.internet.url();

      dispatch(subs, TransportEvent.Connect, server);
      dispatch(subs, TransportEvent.Disconnect);

      // When
      dispatch(subs, TransportEvent.Reconnect, server);

      // Then
      expect(await sampleValue(register, 'jetstream_connection_up', { server })).toBe(1);
    });
  });

  describe('Error → errors_total counter', () => {
    it('should map a known context to its bounded enum value', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(subs, TransportEvent.Error, new Error('boom'), 'event-handler:orders.created');

      // Then
      expect(await sampleValue(register, 'jetstream_errors_total', { context: 'handler' })).toBe(1);
    });

    it('should fall back to "other" when the context is unrecognised', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(subs, TransportEvent.Error, new Error('boom'), 'totally-unknown');

      // Then
      expect(await sampleValue(register, 'jetstream_errors_total', { context: 'other' })).toBe(1);
    });
  });

  describe('RpcTimeout → rpc_timeout_total counter', () => {
    it('should increment using the declared pattern when available', async () => {
      // Given
      const patternRegistry = createMock<PatternRegistry>();

      patternRegistry.resolveDeclared.mockReturnValue({
        pattern: 'orders.get',
        kind: StreamKind.Command,
      });

      const { subs } = await setup({
        options,
        patternRegistry,
        register,
        promClient,
        eventBus,
      });

      // When
      dispatch(
        subs,
        TransportEvent.RpcTimeout,
        'orders__microservice.cmd.orders.get',
        faker.string.uuid(),
      );

      // Then
      expect(
        await sampleValue(register, 'jetstream_rpc_timeout_total', { subject: 'orders.get' }),
      ).toBe(1);
    });

    it('should bucket into the UNMATCHED sentinel when the pattern registry has no entry', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(subs, TransportEvent.RpcTimeout, 'unknown.subject', faker.string.uuid());

      // Then: cardinality stays bounded — no raw wire subject leaks into the label
      expect(
        await sampleValue(register, 'jetstream_rpc_timeout_total', {
          subject: UNMATCHED_SUBJECT_LABEL,
        }),
      ).toBe(1);
    });
  });

  describe('MessageRouted → messages_received_total / messages_unhandled_total', () => {
    it('should increment messages_received_total with declared labels for known subjects', async () => {
      // Given
      const patternRegistry = createMock<PatternRegistry>();

      patternRegistry.resolveDeclared.mockReturnValue({
        pattern: 'orders.created',
        kind: StreamKind.Event,
      });

      const { subs } = await setup({ options, patternRegistry, register, promClient, eventBus });

      // When
      dispatch(
        subs,
        TransportEvent.MessageRouted,
        'orders__microservice.ev.orders.created',
        MessageKind.Event,
      );

      // Then
      expect(
        await sampleValue(register, 'jetstream_messages_received_total', {
          stream: streamName(options.name, StreamKind.Event),
          subject: 'orders.created',
          kind: 'event',
        }),
      ).toBe(1);
    });

    it('should bucket unmatched subjects into messages_unhandled_total with the sentinel label', async () => {
      // Given: no pattern registry (publisher-only or unknown subject path)
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(subs, TransportEvent.MessageRouted, faker.lorem.word(), MessageKind.Event);

      // Then
      expect(
        await sampleValue(register, 'jetstream_messages_unhandled_total', {
          subject: UNMATCHED_SUBJECT_LABEL,
        }),
      ).toBe(1);
    });
  });

  describe('DeadLetter → messages_dead_letter_total counter', () => {
    it('should increment with the declared pattern and stream from the info payload', async () => {
      // Given
      const patternRegistry = createMock<PatternRegistry>();

      patternRegistry.resolveDeclared.mockReturnValue({
        pattern: 'orders.created',
        kind: StreamKind.Event,
      });

      const { subs } = await setup({ options, patternRegistry, register, promClient, eventBus });
      const info: DeadLetterInfo = {
        subject: 'orders__microservice.ev.orders.created',
        data: {},
        headers: undefined,
        error: new Error('failed'),
        deliveryCount: 5,
        stream: 'orders__microservice_ev-stream',
        streamSequence: 42,
        timestamp: new Date().toISOString(),
      };

      // When
      dispatch(subs, TransportEvent.DeadLetter, info);

      // Then
      expect(
        await sampleValue(register, 'jetstream_messages_dead_letter_total', {
          stream: info.stream,
          subject: 'orders.created',
        }),
      ).toBe(1);
    });
  });

  describe('ConsumerRecovered → consumer_recovered_total counter', () => {
    it('should increment with the recovery label as kind', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(subs, TransportEvent.ConsumerRecovered, StreamKind.Event, 3);

      // Then
      expect(
        await sampleValue(register, 'jetstream_consumer_recovered_total', { kind: 'event' }),
      ).toBe(1);
    });
  });

  describe('HandlerCompleted → processed_total + handler_duration_seconds', () => {
    it('should increment processed counter and observe duration when handler succeeds', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(
        subs,
        TransportEvent.HandlerCompleted,
        'orders.created',
        StreamKind.Event,
        250,
        'success',
      );

      // Then
      const labels = {
        stream: streamName(options.name, StreamKind.Event),
        subject: 'orders.created',
        kind: 'event',
        status: 'success',
      };

      expect(await sampleValue(register, 'jetstream_messages_processed_total', labels)).toBe(1);
      expect(await histogramCount(register, 'jetstream_handler_duration_seconds', labels)).toBe(1);
    });

    it('should record the status label verbatim for error/retried/terminated outcomes', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(subs, TransportEvent.HandlerCompleted, 'orders.x', StreamKind.Event, 10, 'error');
      dispatch(subs, TransportEvent.HandlerCompleted, 'orders.x', StreamKind.Event, 10, 'retried');
      dispatch(
        subs,
        TransportEvent.HandlerCompleted,
        'orders.x',
        StreamKind.Event,
        10,
        'terminated',
      );

      // Then
      const baseLabels = {
        stream: streamName(options.name, StreamKind.Event),
        subject: 'orders.x',
        kind: 'event',
      };

      expect(
        await sampleValue(register, 'jetstream_messages_processed_total', {
          ...baseLabels,
          status: 'error',
        }),
      ).toBe(1);
      expect(
        await sampleValue(register, 'jetstream_messages_processed_total', {
          ...baseLabels,
          status: 'retried',
        }),
      ).toBe(1);
      expect(
        await sampleValue(register, 'jetstream_messages_processed_total', {
          ...baseLabels,
          status: 'terminated',
        }),
      ).toBe(1);
    });
  });

  describe('Published → publish_total + publish_duration_seconds', () => {
    it('should increment publish_total and observe duration for a successful event publish', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(
        subs,
        TransportEvent.Published,
        'orders.created',
        StreamKind.Event,
        25,
        'success' satisfies PublishStatus,
      );

      // Then
      const labels = { subject: 'orders.created', kind: 'event', status: 'success' };

      expect(await sampleValue(register, 'jetstream_publish_total', labels)).toBe(1);
      expect(await histogramCount(register, 'jetstream_publish_duration_seconds', labels)).toBe(1);
    });

    it('should record kind=broadcast/ordered/command for the matching StreamKind', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(subs, TransportEvent.Published, 'a', StreamKind.Broadcast, 1, 'success');
      dispatch(subs, TransportEvent.Published, 'b', StreamKind.Ordered, 1, 'success');
      dispatch(subs, TransportEvent.Published, 'c', StreamKind.Command, 1, 'success');

      // Then
      expect(
        await sampleValue(register, 'jetstream_publish_total', {
          subject: 'a',
          kind: 'broadcast',
          status: 'success',
        }),
      ).toBe(1);
      expect(
        await sampleValue(register, 'jetstream_publish_total', {
          subject: 'b',
          kind: 'ordered',
          status: 'success',
        }),
      ).toBe(1);
      expect(
        await sampleValue(register, 'jetstream_publish_total', {
          subject: 'c',
          kind: 'command',
          status: 'success',
        }),
      ).toBe(1);
    });

    it('should record status=error when the publish fails', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(subs, TransportEvent.Published, 'orders.created', StreamKind.Event, 10, 'error');

      // Then
      expect(
        await sampleValue(register, 'jetstream_publish_total', {
          subject: 'orders.created',
          kind: 'event',
          status: 'error',
        }),
      ).toBe(1);
    });
  });

  describe('RpcCompleted → rpc_duration_seconds', () => {
    it('should observe duration with status=success on a successful RPC round-trip', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(
        subs,
        TransportEvent.RpcCompleted,
        'orders.get',
        50,
        'success' satisfies RpcOutcomeStatus,
      );

      // Then
      expect(
        await histogramCount(register, 'jetstream_rpc_duration_seconds', {
          subject: 'orders.get',
          status: 'success',
        }),
      ).toBe(1);
    });

    it('should distinguish error vs timeout outcomes via the status label', async () => {
      // Given
      const { subs } = await setup({ options, register, promClient, eventBus });

      // When
      dispatch(subs, TransportEvent.RpcCompleted, 'orders.get', 5, 'error');
      dispatch(subs, TransportEvent.RpcCompleted, 'orders.get', 5_000, 'timeout');

      // Then
      expect(
        await histogramCount(register, 'jetstream_rpc_duration_seconds', {
          subject: 'orders.get',
          status: 'error',
        }),
      ).toBe(1);
      expect(
        await histogramCount(register, 'jetstream_rpc_duration_seconds', {
          subject: 'orders.get',
          status: 'timeout',
        }),
      ).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('should default pollInterval to 15s when not provided', () => {
      // Given/When
      const sut = new JetstreamMetricsService(eventBus, { register }, promClient, options, null);

      // Then
      expect(sut.getEffectivePollInterval()).toBe(DEFAULT_POLL_INTERVAL_MS);
    });

    it('should throw on bootstrap when registry is missing', async () => {
      // Given: config without register — module factory normally guards this
      const sut = new JetstreamMetricsService(eventBus, {}, promClient, options, null);

      // Then
      await expect(sut.onApplicationBootstrap()).rejects.toThrow(/Registry/);
    });
  });
});
