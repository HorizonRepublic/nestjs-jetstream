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
import { MIGRATION_BACKUP_SUFFIX } from '../stream-migration';

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
  backupInfo?: StreamInfo;
}

type StreamInfoFn = (name: string) => Promise<StreamInfo>;

const makeJsm = (opts: JsmOpts = {}): JetStreamManager => {
  const streamInfo = (opts.streamInfo ?? vi.fn()) as StreamInfoFn;
  const dispatch = vi.fn((name: string) => {
    if (name.endsWith(MIGRATION_BACKUP_SUFFIX)) {
      return opts.backupInfo !== undefined
        ? Promise.resolve(opts.backupInfo)
        : Promise.reject(streamNotFound());
    }

    return streamInfo(name);
  });

  return createMock<JetStreamManager>({
    streams: { info: dispatch },
    consumers: { info: opts.consumerInfo ?? vi.fn() },
  });
};

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

    describe('when an interrupted migration backup exists for the stream', () => {
      it('should warn naming the orphaned backup', async () => {
        // Given: the bound stream has a leftover __migration_backup sibling
        const warnSpy = vi.spyOn(Logger.prototype, 'warn');
        const info = makeStreamInfo();
        const jsm = makeJsm({
          streamInfo: vi.fn().mockResolvedValue(info),
          backupInfo: makeStreamInfo(),
        });
        const sut = makeSut();

        // When
        const result = await sut.bindStream(jsm, StreamKind.Event);

        // Then
        expect(result).toBe(info);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            `${names.streamName(StreamKind.Event)}${MIGRATION_BACKUP_SUFFIX}`,
          ),
        );
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
            err.message.includes('the stream must be provisioned externally before boot'),
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
            err.message.includes('the consumer must be provisioned externally before boot'),
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
        await expect(sut.bindDlqStream(jsm)).rejects.toThrow(
          `DLQ stream "${names.dlqStreamName()}" subjects do not cover`,
        );
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

  describe('bindStream() — unexpected lookup errors', () => {
    it('should rethrow non-NATS errors untouched', async () => {
      // Given: streams.info fails with an infrastructure error, not a 404
      const boom = new Error('connection reset');
      const jsm = makeJsm({ streamInfo: vi.fn().mockRejectedValue(boom) });
      const sut = makeSut();

      // When / Then
      await expect(sut.bindStream(jsm, StreamKind.Event)).rejects.toBe(boom);
    });
  });

  describe('bindConsumer() — unexpected lookup errors', () => {
    it('should rethrow non-NATS errors untouched', async () => {
      // Given: consumers.info fails with an infrastructure error, not a 404
      const boom = new Error('connection reset');
      const jsm = makeJsm({ consumerInfo: vi.fn().mockRejectedValue(boom) });
      const sut = makeSut();

      // When / Then
      await expect(sut.bindConsumer(jsm, StreamKind.Event)).rejects.toBe(boom);
    });
  });

  describe('bindConsumer() — multi-subject filters', () => {
    it('should accept filter_subjects covering every handler subject', async () => {
      // Given: two handlers, consumer filters list both subjects exactly
      const sut = makeSut();

      registry.getPatternsByKind.mockReturnValue({
        events: ['order.created', 'order.cancelled'],
        commands: [],
        broadcasts: [],
        ordered: [],
      });

      const info = makeConsumerInfo({
        filter_subject: undefined,
        filter_subjects: [
          names.subject(StreamKind.Event, 'order.created'),
          names.subject(StreamKind.Event, 'order.cancelled'),
        ],
      });
      const jsm = makeJsm({ consumerInfo: vi.fn().mockResolvedValue(info) });

      // When
      const result = await sut.bindConsumer(jsm, StreamKind.Event);

      // Then
      expect(result).toBe(info);
    });

    it('should throw when filter_subjects miss one of the handler subjects', async () => {
      // Given: second handler subject absent from the filter list
      const sut = makeSut();

      registry.getPatternsByKind.mockReturnValue({
        events: ['order.created', 'order.cancelled'],
        commands: [],
        broadcasts: [],
        ordered: [],
      });

      const info = makeConsumerInfo({
        filter_subject: undefined,
        filter_subjects: [names.subject(StreamKind.Event, 'order.created')],
      });
      const jsm = makeJsm({ consumerInfo: vi.fn().mockResolvedValue(info) });

      // When / Then
      await expect(sut.bindConsumer(jsm, StreamKind.Event)).rejects.toThrow(
        names.subject(StreamKind.Event, 'order.cancelled'),
      );
    });
  });

  describe('bindConsumer() — broadcast kind', () => {
    it('should validate coverage against broadcast handler subjects', async () => {
      // Given: one broadcast handler, consumer filter misses its subject
      const sut = makeSut();
      const broadcastSubject = 'broadcast.config.updated';

      registry.getBroadcastPatterns.mockReturnValue([broadcastSubject]);

      const info = makeConsumerInfo({ filter_subject: 'broadcast.other.>' });
      const jsm = makeJsm({ consumerInfo: vi.fn().mockResolvedValue(info) });

      // When / Then
      await expect(sut.bindConsumer(jsm, StreamKind.Broadcast)).rejects.toThrow(broadcastSubject);
    });
  });

  describe('bindConsumer() — unfiltered consumer', () => {
    const handlerPatterns = {
      events: ['order.created'],
      commands: [],
      broadcasts: [],
      ordered: [],
    };

    describe('when the consumer has no filter at all', () => {
      it('should treat handler subjects as covered', async () => {
        // Given: external consumer without filter_subject or filter_subjects
        const sut = makeSut();

        registry.getPatternsByKind.mockReturnValue(handlerPatterns);

        const info = createMock<ConsumerInfo>({ config: {} as ConsumerConfig });
        const jsm = makeJsm({ consumerInfo: vi.fn().mockResolvedValue(info) });

        // When
        const result = await sut.bindConsumer(jsm, StreamKind.Event);

        // Then
        expect(result).toBe(info);
      });
    });

    describe('when the consumer has no filter and scheduling is enabled', () => {
      it('should throw because the consumer would swallow schedule holders', async () => {
        // Given: scheduling intent + unfiltered consumer receiving the whole stream
        const sut = makeSut({
          ...baseOptions,
          events: { subjectPrefix: 'company.orders.', stream: { allow_msg_schedules: true } },
        });

        registry.getPatternsByKind.mockReturnValue(handlerPatterns);

        const info = createMock<ConsumerInfo>({ config: {} as ConsumerConfig });
        const jsm = makeJsm({ consumerInfo: vi.fn().mockResolvedValue(info) });

        // When / Then
        await expect(sut.bindConsumer(jsm, StreamKind.Event)).rejects.toThrow(
          names.schedulePrefix(StreamKind.Event),
        );
      });
    });
  });

  describe('bindConsumer() — filter swallows schedule holders', () => {
    const scheduleOptions: JetstreamModuleOptions = {
      ...baseOptions,
      events: { subjectPrefix: 'company.orders.', stream: { allow_msg_schedules: true } },
    };

    const orderPatterns = {
      events: ['order.created'],
      commands: [],
      broadcasts: [],
      ordered: [],
    };

    describe('when scheduling is enabled and the filter covers the schedule namespace', () => {
      it('should throw instructing to use exact filters', async () => {
        // Given: catch-all filter that also matches the _sch holder namespace
        const sut = makeSut(scheduleOptions);

        registry.getPatternsByKind.mockReturnValue(orderPatterns);

        const info = makeConsumerInfo({ filter_subject: 'company.orders.>' });
        const jsm = makeJsm({ consumerInfo: vi.fn().mockResolvedValue(info) });

        // When / Then
        await expect(sut.bindConsumer(jsm, StreamKind.Event)).rejects.toThrow(
          names.schedulePrefix(StreamKind.Event),
        );
      });
    });

    describe('when scheduling is enabled and the filters are exact', () => {
      it('should bind successfully', async () => {
        // Given: exact filter on the registered handler subject only
        const sut = makeSut(scheduleOptions);

        registry.getPatternsByKind.mockReturnValue(orderPatterns);

        const info = makeConsumerInfo({ filter_subject: 'company.orders.order.created' });
        const jsm = makeJsm({ consumerInfo: vi.fn().mockResolvedValue(info) });

        // When
        const result = await sut.bindConsumer(jsm, StreamKind.Event);

        // Then
        expect(result).toBe(info);
      });
    });
  });

  describe('bindStream() — scheduling enabled but stream forbids schedules', () => {
    describe('when allow_msg_schedules is not set on the external stream', () => {
      it('should log a warning and still return stream info', async () => {
        // Given: scheduling intent in options, external stream without allow_msg_schedules
        const options: JetstreamModuleOptions = {
          ...baseOptions,
          events: { subjectPrefix: 'company.orders.', stream: { allow_msg_schedules: true } },
        };

        const sut = makeSut(options);
        const warnSpy = vi.spyOn(Logger.prototype, 'warn');
        const info = makeStreamInfo({ subjects: ['company.orders.>'] });
        const jsm = makeJsm({ streamInfo: vi.fn().mockResolvedValue(info) });

        // When
        const result = await sut.bindStream(jsm, StreamKind.Event);

        // Then
        expect(result).toBe(info);

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('allow_msg_schedules'));
      });
    });

    describe('when allow_msg_schedules is set on the external stream', () => {
      it('should not warn', async () => {
        // Given: external stream config allows schedules
        const options: JetstreamModuleOptions = {
          ...baseOptions,
          events: { subjectPrefix: 'company.orders.', stream: { allow_msg_schedules: true } },
        };

        const sut = makeSut(options);
        const warnSpy = vi.spyOn(Logger.prototype, 'warn');
        const info = makeStreamInfo({
          subjects: ['company.orders.>'],
          allow_msg_schedules: true,
        } as Partial<StreamConfig>);
        const jsm = makeJsm({ streamInfo: vi.fn().mockResolvedValue(info) });

        // When
        await sut.bindStream(jsm, StreamKind.Event);

        // Then
        expect(warnSpy).not.toHaveBeenCalled();
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
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('expected "workqueue" for reliable at-least-once delivery'),
        );
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
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('messages will never be dead-lettered'),
        );
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
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('shorter than the ackExtension interval'),
        );
      });
    });
  });
});
