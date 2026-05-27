import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { ConsumerInfo, JetStreamManager, StreamInfo } from '@nats-io/jetstream';

import { StreamKind } from '../../interfaces';

import { createMetrics, type JetstreamMetrics } from '../metrics.factory';
import { PollRunner, type ConsumerPollTarget } from '../poll-runner';

const consumerInfo = (overrides: Partial<ConsumerInfo> = {}): ConsumerInfo =>
  ({
    num_pending: 0,
    num_ack_pending: 0,
    num_redelivered: 0,
    num_waiting: 0,
    ...overrides,
  }) as ConsumerInfo;

const streamInfo = (messages: number, bytes: number): StreamInfo =>
  ({ state: { messages, bytes } }) as StreamInfo;

const sampleValue = async (
  register: Registry,
  name: string,
  labels: Record<string, string>,
): Promise<number | undefined> => {
  const data = await register.getSingleMetric(name)?.get();

  if (!data || !('values' in data)) return undefined;

  return data.values.find((v) =>
    Object.entries(labels).every(([k, val]) => (v.labels as Record<string, unknown>)[k] === val),
  )?.value;
};

describe(PollRunner, () => {
  let register: Registry;
  let metrics: JetstreamMetrics;
  let jsm: JetStreamManager;
  let targets: ConsumerPollTarget[];

  beforeEach(() => {
    register = new Registry();
    metrics = createMetrics({
      register,
      promClient: { Counter, Histogram, Gauge },
    });
    jsm = createMock<JetStreamManager>();
    targets = [
      { kind: StreamKind.Event, stream: 'svc_ev-stream', consumer: 'svc_ev-consumer' },
      { kind: StreamKind.Command, stream: 'svc_cmd-stream', consumer: 'svc_cmd-consumer' },
    ];
  });

  afterEach(() => {
    vi.resetAllMocks();
    register.clear();
  });

  describe('tick()', () => {
    it('should write consumer and stream gauges for each target', async () => {
      // Given
      (jsm.consumers.info as ReturnType<typeof vi.fn>).mockImplementation(
        async (_stream: string, consumer: string) =>
          consumerInfo({
            num_pending: consumer === 'svc_ev-consumer' ? 42 : 7,
            num_ack_pending: 3,
            num_redelivered: 1,
            num_waiting: 4,
          }),
      );
      (jsm.streams.info as ReturnType<typeof vi.fn>).mockImplementation(async (stream: string) =>
        streamInfo(
          stream === 'svc_ev-stream' ? 1_000 : 500,
          stream === 'svc_ev-stream' ? 10_000 : 5_000,
        ),
      );

      const sut = new PollRunner({
        intervalMs: 1_000,
        jsmFactory: async (): Promise<JetStreamManager> => jsm,
        metrics,
        targets,
      });

      // When
      await sut.tick();

      // Then
      expect(
        await sampleValue(register, 'jetstream_consumer_num_pending', {
          stream: 'svc_ev-stream',
          consumer: 'svc_ev-consumer',
          kind: 'event',
        }),
      ).toBe(42);
      expect(
        await sampleValue(register, 'jetstream_consumer_num_pending', {
          stream: 'svc_cmd-stream',
          consumer: 'svc_cmd-consumer',
          kind: 'command',
        }),
      ).toBe(7);
      expect(
        await sampleValue(register, 'jetstream_consumer_num_ack_pending', {
          stream: 'svc_ev-stream',
          consumer: 'svc_ev-consumer',
          kind: 'event',
        }),
      ).toBe(3);
      expect(
        await sampleValue(register, 'jetstream_stream_messages', { stream: 'svc_ev-stream' }),
      ).toBe(1_000);
      expect(
        await sampleValue(register, 'jetstream_stream_bytes', { stream: 'svc_cmd-stream' }),
      ).toBe(5_000);
    });

    it('should isolate consumer failures and continue with the remaining targets', async () => {
      // Given: first consumer.info call throws, second succeeds
      (jsm.consumers.info as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('consumer not found'))
        .mockResolvedValueOnce(consumerInfo({ num_pending: 9 }));
      (jsm.streams.info as ReturnType<typeof vi.fn>).mockResolvedValue(streamInfo(0, 0));

      const sut = new PollRunner({
        intervalMs: 1_000,
        jsmFactory: async (): Promise<JetStreamManager> => jsm,
        metrics,
        targets,
      });

      // When
      await sut.tick();

      // Then: the second consumer's gauge is updated, error counter incremented
      expect(
        await sampleValue(register, 'jetstream_consumer_num_pending', {
          stream: 'svc_cmd-stream',
          consumer: 'svc_cmd-consumer',
          kind: 'command',
        }),
      ).toBe(9);
      expect(
        await sampleValue(register, 'jetstream_metrics_poll_errors_total', {
          target: 'consumer.info',
        }),
      ).toBe(1);
    });

    it('should isolate stream failures from consumer polling', async () => {
      // Given
      (jsm.consumers.info as ReturnType<typeof vi.fn>).mockResolvedValue(consumerInfo());
      (jsm.streams.info as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('stream not found'),
      );

      const sut = new PollRunner({
        intervalMs: 1_000,
        jsmFactory: async (): Promise<JetStreamManager> => jsm,
        metrics,
        targets,
      });

      // When
      await sut.tick();

      // Then: stream poll errors counted, consumer metrics still written
      const errorCount = await sampleValue(register, 'jetstream_metrics_poll_errors_total', {
        target: 'stream.info',
      });

      expect(errorCount).toBe(2);
    });

    it('should record jsm.connect target when factory rejects', async () => {
      // Given
      const sut = new PollRunner({
        intervalMs: 1_000,
        jsmFactory: async (): Promise<JetStreamManager> => {
          throw new Error('disconnected');
        },
        metrics,
        targets,
      });

      // When
      await sut.tick();

      // Then
      expect(
        await sampleValue(register, 'jetstream_metrics_poll_errors_total', {
          target: 'jsm.connect',
        }),
      ).toBe(1);
    });

    it('should deduplicate stream lookups across consumers on the same stream', async () => {
      // Given: two consumers sharing the broadcast stream
      const sharedTargets: ConsumerPollTarget[] = [
        { kind: StreamKind.Broadcast, stream: 'broadcast-stream', consumer: 'a' },
        { kind: StreamKind.Broadcast, stream: 'broadcast-stream', consumer: 'b' },
      ];
      const streamsInfo = vi.fn().mockResolvedValue(streamInfo(0, 0));

      (jsm.consumers.info as ReturnType<typeof vi.fn>).mockResolvedValue(consumerInfo());
      jsm.streams = { info: streamsInfo } as unknown as JetStreamManager['streams'];

      const sut = new PollRunner({
        intervalMs: 1_000,
        jsmFactory: async (): Promise<JetStreamManager> => jsm,
        metrics,
        targets: sharedTargets,
      });

      // When
      await sut.tick();

      // Then
      expect(streamsInfo).toHaveBeenCalledTimes(1);
    });
  });

  describe('start() / stop() lifecycle', () => {
    it('should skip a tick when a previous one is still running (backpressure)', async () => {
      // Given: tick takes 500ms; interval is 50ms
      let resolveFirstTick: () => void = () => {};

      const firstTickPromise = new Promise<void>((r) => {
        resolveFirstTick = r;
      });
      let ticks = 0;

      (jsm.consumers.info as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        ticks++;
        if (ticks === 1) await firstTickPromise;
        return consumerInfo();
      });
      (jsm.streams.info as ReturnType<typeof vi.fn>).mockResolvedValue(streamInfo(0, 0));

      const sut = new PollRunner({
        intervalMs: 50,
        jsmFactory: async (): Promise<JetStreamManager> => jsm,
        metrics,
        targets: [targets[0]!],
      });

      // When
      sut.start();
      await new Promise((r) => setTimeout(r, 250));

      // Then: backpressure prevented overlap — only the first tick is in flight
      expect(ticks).toBe(1);

      // Cleanup: release the first tick, give the runner a chance to advance,
      // then stop. Without this it leaks an interval into other tests.
      resolveFirstTick();
      await new Promise((r) => setTimeout(r, 100));
      await sut.stop();
    });

    it('should not start the timer when intervalMs is 0 or targets are empty', () => {
      const zeroInterval = new PollRunner({
        intervalMs: 0,
        jsmFactory: async (): Promise<JetStreamManager> => jsm,
        metrics,
        targets,
      });
      const noTargets = new PollRunner({
        intervalMs: 1_000,
        jsmFactory: async (): Promise<JetStreamManager> => jsm,
        metrics,
        targets: [],
      });

      // When/Then: start() is a no-op (no detached timer)
      expect(() => {
        zeroInterval.start();
      }).not.toThrow();
      expect(() => {
        noTargets.start();
      }).not.toThrow();
    });

    it('should clear the timer and await in-flight tick on stop()', async () => {
      // Given
      (jsm.consumers.info as ReturnType<typeof vi.fn>).mockResolvedValue(consumerInfo());
      (jsm.streams.info as ReturnType<typeof vi.fn>).mockResolvedValue(streamInfo(0, 0));

      const sut = new PollRunner({
        intervalMs: 30,
        jsmFactory: async (): Promise<JetStreamManager> => jsm,
        metrics,
        targets: [targets[0]!],
      });

      // When
      sut.start();
      await new Promise((r) => setTimeout(r, 100));
      await sut.stop();

      const callsBefore = (jsm.consumers.info as ReturnType<typeof vi.fn>).mock.calls.length;

      await new Promise((r) => setTimeout(r, 100));
      const callsAfter = (jsm.consumers.info as ReturnType<typeof vi.fn>).mock.calls.length;

      // Then: no further ticks after stop()
      expect(callsAfter).toBe(callsBefore);
    });
  });
});
