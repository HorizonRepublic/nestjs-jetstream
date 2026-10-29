import type {
  ConsumerInfo,
  JetStreamManager,
  JsMsg,
  OrderedConsumerOptions,
  PubAck,
  PurgeResponse,
  StreamInfo,
} from '@nats-io/jetstream';
import { JetStreamApiError } from '@nats-io/jetstream';
import { headers as natsHeaders } from '@nats-io/transport-node';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonCodec } from '../../codec';
import { ConnectionRegistry } from '../../connection/connection-registry';
import type { ConnectionScope } from '../../connection/connection.types';
import { ConfigErrorReason, JetstreamConfigError } from '../../errors';
import { StreamKind } from '../../interfaces';
import type { ResolvedConnectionOptions } from '../../interfaces';
import { JetstreamDlqHeader, RESERVED_HEADERS } from '../../jetstream.constants';
import { NameResolver } from '../../server/infrastructure/name-resolver';
import { DeadLetterOrigin, DlqRedriveSkipReason } from '../dlq.types';
import { JetstreamDlq } from '../jetstream-dlq';

const encoder = new TextEncoder();

interface StoredDeadLetter {
  readonly seq: number;
  readonly kind?: StreamKind;
  readonly stream?: string;
  readonly subject?: string;
  readonly data?: Uint8Array;
  readonly extraHeaders?: readonly (readonly [string, string])[];
}

describe(JetstreamDlq, () => {
  let sut: JetstreamDlq;
  let options: ResolvedConnectionOptions;
  let names: NameResolver;
  let stored: JsMsg[];
  let jsm: JetStreamManager;
  let publish: ReturnType<typeof vi.fn>;
  let deleteConsumer: ReturnType<typeof vi.fn>;
  let consumerFilter: string[];

  const deadLetter = (spec: StoredDeadLetter): JsMsg => {
    const kind = spec.kind ?? StreamKind.Event;
    const headers = natsHeaders();

    headers.set(
      JetstreamDlqHeader.OriginalSubject,
      spec.subject ?? names.subject(kind, 'order.created'),
    );
    headers.set(JetstreamDlqHeader.OriginalStream, spec.stream ?? names.streamName(kind));
    headers.set(JetstreamDlqHeader.DeadLetterReason, 'boom');
    headers.set(JetstreamDlqHeader.FailedAt, 'not a date');

    for (const [name, value] of spec.extraHeaders ?? []) headers.append(name, value);

    return createMock<JsMsg>({
      seq: spec.seq,
      data: spec.data ?? encoder.encode('{"id":1}'),
      headers,
      info: { timestampNanos: spec.seq * 1_000, pending: 0 },
    });
  };

  /** Hand out the stored messages, each with the count still behind it, then wait for more forever. */
  async function* storedFrom(startSeq: number): AsyncGenerator<JsMsg> {
    const batch = stored.filter((msg) => msg.seq >= startSeq);

    for (const [index, msg] of batch.entries()) {
      yield { ...msg, info: { ...msg.info, pending: batch.length - index - 1 } } as JsMsg;
    }

    await new Promise(() => undefined);
  }

  beforeEach(() => {
    options = {
      name: faker.lorem.word(),
      servers: ['nats://localhost:4222'],
      connectionName: 'default',
    } as ResolvedConnectionOptions;
    names = new NameResolver(options);
    stored = [];
    consumerFilter = [names.filterSubject(StreamKind.Event)];
    publish = vi.fn().mockResolvedValue(createMock<PubAck>({ duplicate: false }));
    deleteConsumer = vi.fn().mockResolvedValue(true);

    jsm = createMock<JetStreamManager>({
      streams: {
        info: vi.fn(async () =>
          createMock<StreamInfo>({
            state: {
              messages: stored.length,
              first_seq: stored[0]?.seq ?? 0,
              last_seq: stored.at(-1)?.seq ?? 0,
            } as StreamInfo['state'],
          }),
        ),
        deleteMessage: vi.fn().mockResolvedValue(true),
        purge: vi.fn(),
      },
      consumers: {
        info: vi.fn(async () =>
          createMock<ConsumerInfo>({ config: { filter_subjects: consumerFilter } }),
        ),
      },
    });

    const scope = createMock<ConnectionScope>({
      name: 'default',
      options,
      names,
      codec: new JsonCodec(),
      patterns: null,
      connection: {
        getConnection: vi.fn().mockResolvedValue(undefined),
        getJetStreamManager: vi.fn().mockResolvedValue(jsm),
        getJetStreamClient: vi.fn().mockReturnValue({
          publish,
          consumers: {
            get: vi.fn(async (_stream: string, opts: Partial<OrderedConsumerOptions>) => ({
              fetch: vi.fn(async () => storedFrom(opts.opt_start_seq ?? 0)),
              delete: deleteConsumer,
            })),
          },
        }),
      },
    });

    sut = new JetstreamDlq(new ConnectionRegistry(new Map([['default', scope]]), 'default'));
  });

  afterEach(vi.resetAllMocks);

  describe('inspect', () => {
    it('should name the pattern from the subject even with no handlers registered', async () => {
      // Given
      stored = [deadLetter({ seq: 1 })];

      // When
      const [record] = await sut.inspect();

      // Then
      expect(record).toMatchObject({ pattern: 'order.created', origin: DeadLetterOrigin.Event });
    });

    it('should tell schedule ticks and unknown streams apart, and survive odd payloads', async () => {
      // Given
      stored = [
        deadLetter({ seq: 1, kind: StreamKind.Schedule }),
        deadLetter({
          seq: 2,
          stream: 'renamed-stream',
          subject: 'elsewhere.x',
          data: encoder.encode('{no'),
        }),
      ];

      // When
      const records = await sut.inspect();

      // Then
      expect(records.map((r) => r.origin)).toEqual([
        DeadLetterOrigin.Schedule,
        DeadLetterOrigin.Unknown,
      ]);
      expect(records[1]).toMatchObject({
        payload: undefined,
        failedAt: undefined,
        pattern: undefined,
      });
    });

    it('should recognise a broadcast by its subject when its stream was renamed', async () => {
      // Given
      stored = [
        deadLetter({ seq: 1, stream: 'old-broadcast', subject: 'broadcast.config.changed' }),
      ];

      // When
      const [record] = await sut.inspect();

      // Then
      expect(record).toMatchObject({
        origin: DeadLetterOrigin.Broadcast,
        pattern: 'config.changed',
      });
    });

    it('should keep every value of a repeated header', async () => {
      // Given
      stored = [
        deadLetter({
          seq: 1,
          extraHeaders: [
            ['x-tenant', 'acme'],
            ['x-tenant', 'beta, gamma'],
          ],
        }),
      ];

      // When
      const [record] = await sut.inspect();

      // Then
      expect(record!.headers).toEqual({ 'x-tenant': ['acme', 'beta, gamma'] });
    });

    it('should stop at the limit and inside the sequence range', async () => {
      // Given
      stored = [1, 2, 3, 4, 5].map((seq) => deadLetter({ seq }));

      // When
      const limited = await sut.inspect({}, { limit: 2 });
      const ranged = await sut.inspect({ fromSeq: 2, toSeq: 3 });
      const none = await sut.inspect({}, { limit: 0 });

      // Then
      expect(limited.map((r) => r.seq)).toEqual([1, 2]);
      expect(ranged.map((r) => r.seq)).toEqual([2, 3]);
      expect(none).toEqual([]);
    });

    it('should return as soon as nothing is left to read, and remove its consumer', async () => {
      // Given: the newest entries were deleted, so the snapshot's last sequence is never met
      stored = [deadLetter({ seq: 1 }), deadLetter({ seq: 2 })];
      vi.mocked(jsm.streams.info).mockResolvedValueOnce(
        createMock<StreamInfo>({
          state: { messages: 2, first_seq: 1, last_seq: 9 } as StreamInfo['state'],
        }),
      );

      // When
      const records = await sut.inspect();

      // Then
      expect(records).toHaveLength(2);
      expect(deleteConsumer).toHaveBeenCalledOnce();
    });

    it('should read nothing from an empty DLQ', async () => {
      // When/Then
      await expect(sut.inspect()).resolves.toEqual([]);
    });

    it('should say so when the DLQ stream was never created', async () => {
      // Given
      vi.mocked(jsm.streams.info).mockRejectedValue(
        new JetStreamApiError({ err_code: 10059, code: 404, description: 'stream not found' }),
      );

      // When/Then
      await expect(sut.inspect()).rejects.toThrow(
        expect.objectContaining({
          constructor: JetstreamConfigError,
          reason: ConfigErrorReason.DlqUnavailable,
        }),
      );
    });

    it('should pass any other error through', async () => {
      // Given
      vi.mocked(jsm.streams.info).mockRejectedValue(new Error('authorization violation'));

      // When/Then
      await expect(sut.inspect()).rejects.toThrow('authorization violation');
    });

    it('should refuse an unknown connection', async () => {
      // When/Then
      await expect(sut.inspect({}, { connection: 'nope' })).rejects.toMatchObject({
        reason: ConfigErrorReason.UnknownConnection,
      });
    });
  });

  describe('redrive', () => {
    it('should republish with its own headers, a raised redrive count and an id unique to the entry', async () => {
      // Given
      stored = [
        deadLetter({
          seq: 7,
          extraHeaders: [
            ['x-tenant', 'acme'],
            ['Nats-TTL', '5s'],
          ],
        }),
      ];

      // When
      await sut.redrive();

      // Then
      const [subject, , opts] = publish.mock.calls[0]!;

      expect(subject).toBe(names.subject(StreamKind.Event, 'order.created'));
      expect(opts.msgID).toBe(`dlq:${names.dlqStreamName()}:7:7000`);
      expect(opts.headers.get('x-tenant')).toBe('acme');
      expect(opts.headers.get('Nats-TTL')).toBe('');
      expect(opts.headers.get(JetstreamDlqHeader.RedriveCount)).toBe('1');
      expect(opts.headers.get(JetstreamDlqHeader.DeadLetterReason)).toBe('');
      expect(jsm.streams.deleteMessage).toHaveBeenCalledWith(names.dlqStreamName(), 7, false);
    });

    it.each([
      [DeadLetterOrigin.Schedule, StreamKind.Schedule, DlqRedriveSkipReason.ScheduleTick],
      [DeadLetterOrigin.Broadcast, StreamKind.Broadcast, DlqRedriveSkipReason.Broadcast],
    ])('should never send a %s back', async (_, kind, reason) => {
      // Given
      stored = [deadLetter({ seq: 1, kind })];

      // When
      const report = await sut.redrive();

      // Then
      expect(report.skipped).toEqual([expect.objectContaining({ reason })]);
      expect(publish).not.toHaveBeenCalled();
    });

    it('should keep a dead letter whose subject no consumer would deliver', async () => {
      // Given: a custom prefix narrows the consumer to the handlers that still exist
      consumerFilter = [names.subject(StreamKind.Event, 'order.paid')];
      stored = [deadLetter({ seq: 1 })];

      // When
      const report = await sut.redrive();

      // Then
      expect(report.skipped).toEqual([
        expect.objectContaining({ reason: DlqRedriveSkipReason.NoConsumer }),
      ]);
      expect(publish).not.toHaveBeenCalled();
      expect(jsm.streams.deleteMessage).not.toHaveBeenCalled();
    });

    it('should keep a dead letter whose consumer does not exist', async () => {
      // Given
      vi.mocked(jsm.consumers.info).mockRejectedValue(
        new JetStreamApiError({ err_code: 10014, code: 404, description: 'consumer not found' }),
      );
      stored = [deadLetter({ seq: 1 }), deadLetter({ seq: 2, stream: 'renamed', subject: 'x.y' })];

      // When
      const report = await sut.redrive();

      // Then
      expect(report.skipped.map((s) => s.reason)).toEqual([
        DlqRedriveSkipReason.NoConsumer,
        DlqRedriveSkipReason.NoConsumer,
      ]);
    });

    it.each([
      ['a single filter subject', { filter_subject: '' }],
      ['no filter at all', {}],
    ])('should send a dead letter back to a consumer with %s', async (_, config) => {
      // Given
      const filter = { ...config };

      if ('filter_subject' in filter) filter.filter_subject = names.filterSubject(StreamKind.Event);
      vi.mocked(jsm.consumers.info).mockResolvedValue(createMock<ConsumerInfo>({ config: filter }));
      stored = [deadLetter({ seq: 1 })];

      // When
      const report = await sut.redrive();

      // Then
      expect(report.redriven).toEqual([1]);
    });

    it('should pass through an unexpected error reading the consumer', async () => {
      // Given
      vi.mocked(jsm.consumers.info).mockRejectedValue(new Error('authorization violation'));
      stored = [deadLetter({ seq: 1 })];

      // When/Then
      await expect(sut.redrive()).rejects.toThrow('authorization violation');
    });

    it('should keep a dead letter it could not publish, and report why', async () => {
      // Given
      stored = [deadLetter({ seq: 1 })];
      publish.mockRejectedValue(new Error('no responders'));

      // When
      const report = await sut.redrive();

      // Then
      expect(report.skipped).toEqual([
        expect.objectContaining({
          seq: 1,
          reason: DlqRedriveSkipReason.PublishFailed,
          error: 'no responders',
        }),
      ]);
      expect(jsm.streams.deleteMessage).not.toHaveBeenCalled();
    });

    it('should list what went back but stayed in the DLQ', async () => {
      // Given
      stored = [deadLetter({ seq: 1 })];
      vi.mocked(jsm.streams.deleteMessage).mockRejectedValue(new Error('timeout'));

      // When
      const report = await sut.redrive();

      // Then
      expect(report).toMatchObject({ redriven: [1], notRemoved: [1] });
    });

    it('should pace every publish when asked, failed ones included', async () => {
      // Given
      stored = [1, 2, 3].map((seq) => deadLetter({ seq }));
      publish.mockRejectedValue(new Error('no responders'));

      const startedAt = Date.now();

      // When
      await sut.redrive({}, { perSecond: 20 });

      // Then
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    });
  });

  describe('purge', () => {
    it('should refuse to purge with an empty filter', async () => {
      // Given
      stored = [deadLetter({ seq: 1 })];

      // When/Then
      await expect(sut.purge({})).rejects.toMatchObject({
        reason: ConfigErrorReason.DlqFilterRequired,
      });
      expect(jsm.streams.purge).not.toHaveBeenCalled();
      expect(jsm.streams.deleteMessage).not.toHaveBeenCalled();
    });

    it('should empty the whole DLQ in one call only when asked to by name', async () => {
      // Given
      stored = [1, 2, 3].map((seq) => deadLetter({ seq }));
      vi.mocked(jsm.streams.purge).mockResolvedValue(createMock<PurgeResponse>({ purged: 3 }));

      // When
      const report = await sut.purgeAll();

      // Then
      expect(report).toEqual({ dryRun: false, purged: 3 });
      expect(jsm.streams.purge).toHaveBeenCalledWith(names.dlqStreamName());
      expect(jsm.streams.deleteMessage).not.toHaveBeenCalled();
    });

    it('should leave everything after the upper bound when only that bound is given', async () => {
      // Given
      stored = [1, 2, 3].map((seq) => deadLetter({ seq }));
      vi.mocked(jsm.streams.purge).mockResolvedValue(createMock<PurgeResponse>({ purged: 2 }));

      // When
      const report = await sut.purge({ toSeq: 2 });

      // Then
      expect(report.purged).toBe(2);
      expect(jsm.streams.purge).toHaveBeenCalledWith(names.dlqStreamName(), { seq: 3 });
    });

    it('should delete one by one when a lower bound would spare older entries', async () => {
      // Given
      stored = [1, 2, 3].map((seq) => deadLetter({ seq }));

      // When
      const report = await sut.purge({ fromSeq: 2 });

      // Then
      expect(report.purged).toBe(2);
      expect(jsm.streams.purge).not.toHaveBeenCalled();
      expect(vi.mocked(jsm.streams.deleteMessage).mock.calls.map(([, seq]) => seq)).toEqual([2, 3]);
    });

    it('should delete every match of a filter, in batches', async () => {
      // Given: more matches than one batch holds
      stored = Array.from({ length: 70 }, (_, i) => deadLetter({ seq: i + 1 }));

      // When
      const report = await sut.purge({ pattern: 'order.created' });

      // Then
      expect(report.purged).toBe(70);
      expect(jsm.streams.purge).not.toHaveBeenCalled();
      expect(jsm.streams.deleteMessage).toHaveBeenCalledTimes(70);
    });

    it('should count only what was actually deleted', async () => {
      // Given
      stored = [1, 2].map((seq) => deadLetter({ seq }));
      vi.mocked(jsm.streams.deleteMessage)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('timeout'));

      // When
      const report = await sut.purge({ pattern: 'order.created' });

      // Then
      expect(report.purged).toBe(1);
    });

    it('should report what a dry run would delete without deleting it', async () => {
      // Given
      stored = [deadLetter({ seq: 4 })];

      // When
      const report = await sut.purge({ pattern: 'order.created' }, { dryRun: true });
      const everything = await sut.purgeAll({ dryRun: true });

      // Then
      expect(report).toEqual({ dryRun: true, purged: 1 });
      expect(everything).toEqual({ dryRun: true, purged: 1 });
      expect(jsm.streams.purge).not.toHaveBeenCalled();
      expect(jsm.streams.deleteMessage).not.toHaveBeenCalled();
    });

    it('should honour a limit by deleting one by one', async () => {
      // Given
      stored = [1, 2, 3].map((seq) => deadLetter({ seq }));

      // When
      const report = await sut.purge({ pattern: 'order.created' }, { limit: 2 });

      // Then
      expect(report.purged).toBe(2);
      expect(jsm.streams.purge).not.toHaveBeenCalled();
    });
  });

  it('should keep the redrive count out of reach of setHeader', () => {
    expect(RESERVED_HEADERS.has(JetstreamDlqHeader.RedriveCount)).toBe(true);
  });
});
