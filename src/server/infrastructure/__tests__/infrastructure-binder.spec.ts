import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import {
  JetStreamApiError,
  RetentionPolicy,
  type ConsumerConfig,
  type ConsumerInfo,
  type JetStreamManager,
  type StreamConfig,
  type StreamInfo,
} from '@nats-io/jetstream';

import { ManagementMode, StreamKind } from '../../../interfaces';
import type { JetstreamModuleOptions } from '../../../interfaces';
import { PatternRegistry } from '../../routing';

import { InfrastructureBinder } from '../infrastructure-binder';
import { JetstreamProvisioningError } from '../provisioning-error';
import { NameResolver } from '../name-resolver';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const streamNotFound = (): JetStreamApiError =>
  new JetStreamApiError({ err_code: 10059, code: 404, description: 'stream not found' });

const consumerNotFound = (): JetStreamApiError =>
  new JetStreamApiError({ err_code: 10014, code: 404, description: 'consumer not found' });

interface JsmOpts {
  streamInfo?: ReturnType<typeof vi.fn>;
  consumerInfo?: ReturnType<typeof vi.fn>;
}

const makeJsm = (opts: JsmOpts = {}): JetStreamManager =>
  createMock<JetStreamManager>({
    streams: { info: opts.streamInfo ?? vi.fn() },
    consumers: { info: opts.consumerInfo ?? vi.fn() },
  });

const makeStreamInfo = (config: Partial<StreamConfig> = {}): StreamInfo =>
  createMock<StreamInfo>({
    config: {
      retention: RetentionPolicy.Workqueue,
      subjects: ['svc__microservice.ev.>'],
      ...config,
    } as StreamConfig,
  });

const makeConsumerInfo = (config: Partial<ConsumerConfig> = {}): ConsumerInfo =>
  createMock<ConsumerInfo>({
    config: {
      filter_subject: 'svc__microservice.ev.>',
      ...config,
    } as ConsumerConfig,
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(InfrastructureBinder.name, () => {
  afterEach(vi.resetAllMocks);

  const serviceName = faker.lorem.word();

  const baseOptions: JetstreamModuleOptions = {
    name: serviceName,
    servers: ['nats://localhost:4222'],
    provisioning: { management: ManagementMode.Manual },
  };

  let names: NameResolver;
  let registry: ReturnType<typeof createMock<PatternRegistry>>;

  const emptyPatterns = { events: [], commands: [], broadcasts: [], ordered: [] };

  const makeSut = (options: JetstreamModuleOptions = baseOptions): InfrastructureBinder => {
    names = new NameResolver(options);
    registry = createMock<PatternRegistry>();
    // Default: no registered patterns
    registry.getPatternsByKind.mockReturnValue(emptyPatterns);
    registry.getBroadcastPatterns.mockReturnValue([]);
    registry.getOrderedSubjects.mockReturnValue([]);

    return new InfrastructureBinder(options, names, registry);
  };

  // -------------------------------------------------------------------------
  // Happy paths
  // -------------------------------------------------------------------------

  describe('bindStream()', () => {
    describe('when stream exists', () => {
      it('should return the StreamInfo untouched', async () => {
        // Given: jsm.streams.info resolves successfully
        const info = makeStreamInfo();
        const jsm = makeJsm({ streamInfo: vi.fn().mockResolvedValue(info) });
        const sut = makeSut();

        // When
        const result = await sut.bindStream(jsm, StreamKind.Event);

        // Then
        expect(result).toBe(info);
      });
    });
  });

  describe('bindConsumer()', () => {
    describe('when consumer exists and filter covers registered handlers', () => {
      it('should return the ConsumerInfo untouched', async () => {
        // Given: a registered event handler + consumer whose filter covers it
        const sut = makeSut();
        const pattern = faker.lorem.slug();

        registry.getPatternsByKind.mockReturnValue({
          events: [pattern],
          commands: [],
          broadcasts: [],
          ordered: [],
        });

        const consumerFilter = names.filterSubject(StreamKind.Event);
        const info = makeConsumerInfo({ filter_subject: consumerFilter });
        const jsm = makeJsm({ consumerInfo: vi.fn().mockResolvedValue(info) });

        // When
        const result = await sut.bindConsumer(jsm, StreamKind.Event);

        // Then
        expect(result).toBe(info);
        expect(jsm.consumers.info).toHaveBeenCalledWith(
          names.streamName(StreamKind.Event),
          names.consumerName(StreamKind.Event),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // bindStream — entity-missing throw
  // -------------------------------------------------------------------------

  describe('bindStream() — missing stream', () => {
    describe('when stream does not exist', () => {
      it('should throw a JetstreamProvisioningError naming the stream and instructing to provision it', async () => {
        // Given: jsm.streams.info throws StreamNotFound
        const jsm = makeJsm({ streamInfo: vi.fn().mockRejectedValue(streamNotFound()) });
        const sut = makeSut();

        // When / Then
        await expect(sut.bindStream(jsm, StreamKind.Event)).rejects.toSatisfy(
          (err: unknown) =>
            err instanceof JetstreamProvisioningError &&
            err.message.includes(names.streamName(StreamKind.Event)) &&
            err.message.includes('Manual'),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // bindDlqStream — entity-missing throw
  // -------------------------------------------------------------------------

  describe('bindDlqStream() — missing DLQ stream', () => {
    describe('when DLQ stream does not exist', () => {
      it('should throw a JetstreamProvisioningError naming the DLQ stream', async () => {
        // Given: jsm.streams.info throws StreamNotFound
        const jsm = makeJsm({ streamInfo: vi.fn().mockRejectedValue(streamNotFound()) });
        const sut = makeSut();

        // When / Then
        await expect(sut.bindDlqStream(jsm)).rejects.toSatisfy(
          (err: unknown) =>
            err instanceof JetstreamProvisioningError &&
            err.message.includes(names.dlqStreamName()),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // bindConsumer — entity-missing throw
  // -------------------------------------------------------------------------

  describe('bindConsumer() — missing consumer', () => {
    describe('when consumer does not exist', () => {
      it('should throw a JetstreamProvisioningError naming the consumer and instructing to provision it', async () => {
        // Given: jsm.consumers.info throws ConsumerNotFound
        const jsm = makeJsm({ consumerInfo: vi.fn().mockRejectedValue(consumerNotFound()) });
        const sut = makeSut();

        // When / Then
        await expect(sut.bindConsumer(jsm, StreamKind.Event)).rejects.toSatisfy(
          (err: unknown) =>
            err instanceof JetstreamProvisioningError &&
            err.message.includes(names.consumerName(StreamKind.Event)) &&
            err.message.includes('Manual'),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Handler subject coverage — throw
  // -------------------------------------------------------------------------

  describe('bindConsumer() — uncovered handler subjects', () => {
    describe('when consumer filter does not cover a registered handler subject', () => {
      it('should throw listing the uncovered subjects', async () => {
        // Given: a registered event handler whose subject is NOT covered by the consumer filter
        const sut = makeSut();
        const pattern = 'orders.placed';

        registry.getPatternsByKind.mockReturnValue({
          events: [pattern],
          commands: [],
          broadcasts: [],
          ordered: [],
        });

        const uncoveredSubject = names.subject(StreamKind.Event, pattern);
        // Consumer only filters a completely different subject
        const info = makeConsumerInfo({ filter_subject: 'other.service.ev.>' });
        const jsm = makeJsm({ consumerInfo: vi.fn().mockResolvedValue(info) });

        // When / Then
        await expect(sut.bindConsumer(jsm, StreamKind.Event)).rejects.toThrow(uncoveredSubject);
      });
    });
  });

  // -------------------------------------------------------------------------
  // DLQ stream subjects coverage — throw
  // -------------------------------------------------------------------------

  describe('bindDlqStream() — DLQ subject not in stream subjects', () => {
    describe('when DLQ stream subjects do not include the DLQ subject', () => {
      it('should throw naming the missing DLQ subject', async () => {
        // Given: DLQ stream exists but its subjects list does not cover the DLQ subject
        const dlqInfo = createMock<StreamInfo>({
          config: {
            subjects: ['completely.different.subject'],
          } as StreamConfig,
        });

        const jsm = makeJsm({ streamInfo: vi.fn().mockResolvedValue(dlqInfo) });
        const sut = makeSut();

        // When / Then
        await expect(sut.bindDlqStream(jsm)).rejects.toThrow(names.dlqStreamName());
      });
    });
  });

  // -------------------------------------------------------------------------
  // Schedule coverage — throw
  // -------------------------------------------------------------------------

  describe('bindStream() — scheduling enabled but schedule prefix not covered', () => {
    describe('when allow_msg_schedules is set and stream subjects miss the schedule prefix', () => {
      it('should throw naming the missing schedule prefix', async () => {
        // Given: options have allow_msg_schedules = true for events
        const options: JetstreamModuleOptions = {
          ...baseOptions,
          events: { stream: { allow_msg_schedules: true } },
        };

        const sut = makeSut(options);

        // Stream subjects cover the event subject but NOT the schedule prefix
        const eventFilter = names.filterSubject(StreamKind.Event);
        const info = makeStreamInfo({ subjects: [eventFilter] });
        const jsm = makeJsm({ streamInfo: vi.fn().mockResolvedValue(info) });

        // When / Then
        await expect(sut.bindStream(jsm, StreamKind.Event)).rejects.toThrow(
          names.schedulePrefix(StreamKind.Event),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Retention mismatch — warn
  // -------------------------------------------------------------------------

  describe('bindStream() — retention mismatch', () => {
    describe('when Event stream has non-workqueue retention', () => {
      it('should log a warning and still return stream info', async () => {
        // Given: stream has Limits retention (wrong for events/commands)
        const warnSpy = vi.spyOn(Logger.prototype, 'warn');
        const info = makeStreamInfo({ retention: RetentionPolicy.Limits });
        const jsm = makeJsm({ streamInfo: vi.fn().mockResolvedValue(info) });
        const sut = makeSut();

        // When
        const result = await sut.bindStream(jsm, StreamKind.Event);

        // Then: returns info and warns
        expect(result).toBe(info);

        expect(warnSpy).toHaveBeenCalledOnce();
      });
    });
  });

  // -------------------------------------------------------------------------
  // DLQ enabled but unlimited max_deliver — warn
  // -------------------------------------------------------------------------

  describe('bindConsumer() — dlq enabled with unlimited max_deliver', () => {
    describe('when options.dlq is set and consumer max_deliver is 0 (unlimited)', () => {
      it('should log a warning and still return consumer info', async () => {
        // Given: dlq enabled, consumer max_deliver = 0
        const options: JetstreamModuleOptions = {
          ...baseOptions,
          dlq: {},
        };

        const sut = makeSut(options);
        const warnSpy = vi.spyOn(Logger.prototype, 'warn');
        const info = makeConsumerInfo({
          filter_subject: names.filterSubject(StreamKind.Event),
          max_deliver: 0,
        });
        const jsm = makeJsm({ consumerInfo: vi.fn().mockResolvedValue(info) });

        // When
        const result = await sut.bindConsumer(jsm, StreamKind.Event);

        // Then
        expect(result).toBe(info);

        expect(warnSpy).toHaveBeenCalledOnce();
      });
    });
  });

  // -------------------------------------------------------------------------
  // ackExtension — ack_wait too short — warn
  // -------------------------------------------------------------------------

  describe('bindConsumer() — ack_wait shorter than ackExtension interval', () => {
    describe('when ackExtension is configured and consumer ack_wait is shorter than the interval', () => {
      it('should log a warning and still return consumer info', async () => {
        // Given: ackExtension = 10_000 ms, ack_wait = 5_000_000_000 ns (= 5s < 10s)
        const ackExtensionMs = 10_000;
        const ackWaitNanos = 5_000_000_000; // 5s in ns

        const options: JetstreamModuleOptions = {
          ...baseOptions,
          events: { ackExtension: ackExtensionMs },
        };

        const sut = makeSut(options);
        const warnSpy = vi.spyOn(Logger.prototype, 'warn');
        const info = makeConsumerInfo({
          filter_subject: names.filterSubject(StreamKind.Event),
          ack_wait: ackWaitNanos,
        });
        const jsm = makeJsm({ consumerInfo: vi.fn().mockResolvedValue(info) });

        // When
        const result = await sut.bindConsumer(jsm, StreamKind.Event);

        // Then
        expect(result).toBe(info);

        expect(warnSpy).toHaveBeenCalledOnce();
      });
    });
  });
});
