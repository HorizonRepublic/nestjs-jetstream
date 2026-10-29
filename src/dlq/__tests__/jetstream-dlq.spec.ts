import type {
  JetStreamManager,
  JsMsg,
  OrderedConsumerOptions,
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
import { JetstreamDlqHeader } from '../../jetstream.constants';
import { NameResolver } from '../../server/infrastructure/name-resolver';
import { DeadLetterOrigin, RedriveSkipReason } from '../dlq.types';
import { JetstreamDlq } from '../jetstream-dlq';

const encoder = new TextEncoder();

describe(JetstreamDlq, () => {
  let sut: JetstreamDlq;
  let options: ResolvedConnectionOptions;
  let names: NameResolver;
  let stored: JsMsg[];
  let jsm: JetStreamManager;
  let publish: ReturnType<typeof vi.fn>;

  const deadLetter = (seq: number, stream: string, data = encoder.encode('{"id":1}')): JsMsg => {
    const headers = natsHeaders();

    headers.set(JetstreamDlqHeader.OriginalSubject, `${stream}.subject`);
    headers.set(JetstreamDlqHeader.OriginalStream, stream);
    headers.set(JetstreamDlqHeader.DeadLetterReason, 'boom');
    headers.set(JetstreamDlqHeader.FailedAt, 'not a date');
    headers.set('x-tenant', 'acme');

    return createMock<JsMsg>({ seq, data, headers });
  };

  async function* storedFrom(startSeq: number): AsyncGenerator<JsMsg> {
    yield* stored.filter((msg) => msg.seq >= startSeq);
  }

  beforeEach(() => {
    options = {
      name: faker.lorem.word(),
      servers: ['nats://localhost:4222'],
      connectionName: 'default',
    } as ResolvedConnectionOptions;
    names = new NameResolver(options);
    stored = [];
    publish = vi.fn().mockResolvedValue(undefined);

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
            })),
          },
        }),
      },
    });

    sut = new JetstreamDlq(new ConnectionRegistry(new Map([['default', scope]]), 'default'));
  });

  afterEach(vi.resetAllMocks);

  it('should tell schedule ticks and unknown streams apart, and survive odd payloads', async () => {
    // Given
    stored = [
      deadLetter(1, names.streamName(StreamKind.Schedule)),
      deadLetter(2, 'renamed-stream', encoder.encode('{not json')),
    ];

    // When
    const records = await sut.inspect();

    // Then
    expect(records.map((r) => r.origin)).toEqual([
      DeadLetterOrigin.Schedule,
      DeadLetterOrigin.Unknown,
    ]);
    expect(records[1]).toMatchObject({ payload: undefined, failedAt: undefined });
    expect(records[0]!.headers).toEqual({ 'x-tenant': 'acme' });
  });

  it('should stop at the limit and inside the sequence range', async () => {
    // Given
    const stream = names.streamName(StreamKind.Event);

    stored = [1, 2, 3, 4, 5].map((seq) => deadLetter(seq, stream));

    // When
    const limited = await sut.inspect({}, { limit: 2 });
    const ranged = await sut.inspect({ fromSeq: 2, toSeq: 3 });

    // Then
    expect(limited.map((r) => r.seq)).toEqual([1, 2]);
    expect(ranged.map((r) => r.seq)).toEqual([2, 3]);
  });

  it('should republish with the original headers, a raised redrive count and a stable message id', async () => {
    // Given
    stored = [deadLetter(7, names.streamName(StreamKind.Event))];

    // When
    await sut.redrive();

    // Then
    const [subject, , opts] = publish.mock.calls[0]!;

    expect(subject).toBe(`${names.streamName(StreamKind.Event)}.subject`);
    expect(opts.msgID).toBe(`dlq:${names.dlqStreamName()}:7`);
    expect(opts.headers.get('x-tenant')).toBe('acme');
    expect(opts.headers.get(JetstreamDlqHeader.RedriveCount)).toBe('1');
    expect(opts.headers.get(JetstreamDlqHeader.DeadLetterReason)).toBe('');
    expect(jsm.streams.deleteMessage).toHaveBeenCalledWith(names.dlqStreamName(), 7, false);
  });

  it('should keep a dead letter it could not publish, and report why', async () => {
    // Given
    stored = [deadLetter(1, names.streamName(StreamKind.Event))];
    publish.mockRejectedValue(new Error('no responders'));

    // When
    const report = await sut.redrive();

    // Then
    expect(report.skipped).toEqual([
      expect.objectContaining({
        seq: 1,
        reason: RedriveSkipReason.PublishFailed,
        error: 'no responders',
      }),
    ]);
    expect(jsm.streams.deleteMessage).not.toHaveBeenCalled();
  });

  it('should list what went back but stayed in the DLQ', async () => {
    // Given
    stored = [deadLetter(1, names.streamName(StreamKind.Event))];
    vi.mocked(jsm.streams.deleteMessage).mockRejectedValue(new Error('timeout'));

    // When
    const report = await sut.redrive();

    // Then
    expect(report).toMatchObject({ redriven: [1], notRemoved: [1] });
  });

  it('should pace publishes when asked', async () => {
    // Given
    const stream = names.streamName(StreamKind.Event);

    stored = [1, 2, 3].map((seq) => deadLetter(seq, stream));

    const startedAt = Date.now();

    // When
    await sut.redrive({}, { perSecond: 20 });

    // Then
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
  });

  it('should report what a dry-run purge would delete without deleting it', async () => {
    // Given
    stored = [deadLetter(4, names.streamName(StreamKind.Event))];

    // When
    const report = await sut.purge({}, { dryRun: true });

    // Then
    expect(report).toEqual({ dryRun: true, purged: [4] });
    expect(jsm.streams.deleteMessage).not.toHaveBeenCalled();
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
