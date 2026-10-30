import { JetStreamApiError } from '@nats-io/jetstream';
import type { JetStreamClient as NatsJsClient, JetStreamManager, PubAck } from '@nats-io/jetstream';
import type { Msg, MsgHdrs, NatsConnection, Status, Subscription } from '@nats-io/transport-node';
import { headers as natsHeaders } from '@nats-io/transport-node';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { firstValueFrom, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { ConnectionProvider } from '../../connection';
import { ServerCapabilities } from '../../connection/server-capabilities';
import {
  ConfigErrorReason,
  ConnectionErrorReason,
  PublishErrorReason,
  RecordErrorReason,
  RpcErrorReason,
} from '../../errors';
import { EventBus } from '../../hooks';
import type { Codec, JetstreamModuleOptions, TargetSubjectPrefixes } from '../../interfaces';
import { TransportEvent } from '../../interfaces';
import {
  DEFAULT_JETSTREAM_RPC_TIMEOUT,
  DEFAULT_RPC_TIMEOUT,
  toNanos,
  JetstreamHeader,
} from '../../jetstream.constants';
import { ScheduleErrorReason } from '../../schedule';
import { NameResolver } from '../../server/infrastructure/name-resolver';
import { NatsErrorCode } from '../../server/infrastructure/nats-error-codes';
import { JetstreamClient } from '../jetstream.client';
import { JetstreamRecordBuilder } from '../jetstream.record';
import { RpcReplyInbox } from '../rpc-reply-inbox';

describe(JetstreamClient, () => {
  let sut: JetstreamClient;

  let connection: Mocked<ConnectionProvider>;
  let codec: Mocked<Codec>;
  let eventBus: Mocked<EventBus>;
  let mockNc: Mocked<NatsConnection>;
  let mockJs: Mocked<NatsJsClient>;

  let options: JetstreamModuleOptions;
  let targetName: string;
  let statusSubject: Subject<Status>;

  beforeEach(() => {
    statusSubject = new Subject<Status>();
    targetName = faker.lorem.word();
    options = {
      name: faker.lorem.word(),
      servers: ['nats://localhost:4222'],
    };

    mockJs = createMock<NatsJsClient>({
      publish: vi.fn().mockResolvedValue({ stream: 'test', seq: 1, duplicate: false } as PubAck),
    });

    mockNc = createMock<NatsConnection>({
      request: vi.fn(),
      subscribe: vi.fn().mockReturnValue(createMock<Subscription>()),
    });

    connection = createMock<ConnectionProvider>({
      getConnection: vi.fn().mockResolvedValue(mockNc),
      getJetStreamClient: vi.fn().mockReturnValue(mockJs),
      unwrap: mockNc,
      status$: statusSubject.asObservable(),
    });

    codec = createMock<Codec>({
      decode: vi.fn((data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))),
      encode: vi.fn((data: unknown) => new TextEncoder().encode(JSON.stringify(data))),
    });

    eventBus = createMock<EventBus>();

    sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
  });

  afterEach(async () => {
    await sut.close();
    vi.resetAllMocks();
  });

  describe('connect()', () => {
    describe('happy path', () => {
      it('should return the NatsConnection', async () => {
        // When: connected
        const nc = await sut.connect();

        // Then: connection returned
        expect(nc).toBe(mockNc);
        expect(connection.getConnection).toHaveBeenCalled();
      });
    });

    describe('when in core RPC mode (default)', () => {
      it('should NOT set up inbox subscription', async () => {
        // When: connected in core mode
        await sut.connect();

        // Then: no subscription created
        expect(mockNc.subscribe).not.toHaveBeenCalled();
      });
    });

    describe('when in jetstream RPC mode', () => {
      beforeEach(() => {
        options.rpc = { mode: 'jetstream' };
        sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
      });

      it('should set up inbox subscription', async () => {
        // When: connected in jetstream mode
        await sut.connect();

        // Then: inbox subscription created
        expect(mockNc.subscribe).toHaveBeenCalledWith(
          expect.stringContaining(`${options.name}__microservice`),
          expect.objectContaining({ callback: expect.any(Function) }),
        );
      });

      it('should only create inbox once on multiple connect calls', async () => {
        // When: connected twice
        await sut.connect();
        await sut.connect();

        // Then: only one subscription
        expect(mockNc.subscribe).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('close()', () => {
    describe('happy path', () => {
      it('should unsubscribe inbox in jetstream mode', async () => {
        // Given: jetstream mode with inbox
        options.rpc = { mode: 'jetstream' };
        sut = new JetstreamClient(options, targetName, connection, codec, eventBus);

        const mockSub = createMock<Subscription>();

        mockNc.subscribe.mockReturnValue(mockSub);
        await sut.connect();

        // When: closed
        await sut.close();

        // Then: unsubscribed
        expect(mockSub.unsubscribe).toHaveBeenCalled();
      });
    });

    describe('edge cases', () => {
      it('should no-op when no inbox was created', async () => {
        // When: close without connect
        await expect(sut.close()).resolves.toBeUndefined();
      });
    });

    describe('inbox reset', () => {
      it('should null out inbox on close, matching handleDisconnect behavior', async () => {
        // Given: jetstream mode, connected (inbox created)
        options.rpc = { mode: 'jetstream' };
        sut = new JetstreamClient(options, targetName, connection, codec, eventBus);

        mockNc.subscribe.mockReturnValue(createMock<Subscription>());
        await sut.connect();

        // When: close
        await sut.close();

        // Then: inbox is reset (symmetric with handleDisconnect)
        const rpcInbox = Reflect.get(sut, 'rpcInbox') as RpcReplyInbox;

        expect(rpcInbox.address).toBeNull();
      });
    });
  });

  describe('unwrap()', () => {
    it('should return the raw connection from provider', () => {
      expect(sut.unwrap()).toBe(mockNc);
    });

    it('should throw when connection is not established', () => {
      // Given: connection.unwrap returns null
      Object.defineProperty(connection, 'unwrap', { get: () => null, configurable: true });

      // When/Then
      expect(() => sut.unwrap()).toThrow(
        expect.objectContaining({
          name: 'JetstreamConnectionError',
          reason: ConnectionErrorReason.NotConnected,
          message: expect.stringContaining('Not connected'),
        }),
      );
    });
  });

  describe('emit() / dispatchEvent()', () => {
    describe('happy path', () => {
      it('should publish event to workqueue stream', async () => {
        // Given: plain event data
        const data = { userId: faker.number.int() };

        // When: event emitted
        await firstValueFrom(sut.emit('user.created', data));

        // Then: published to workqueue subject
        expect(mockJs.publish).toHaveBeenCalledWith(
          `${targetName}__microservice.ev.user.created`,
          codec.encode(data),
          expect.objectContaining({ headers: expect.anything() }),
        );
      });

      it('should publish broadcast event to broadcast subject', async () => {
        // Given: broadcast-prefixed event
        const data = { config: faker.lorem.word() };

        // When: broadcast event emitted
        await firstValueFrom(sut.emit('broadcast:config.updated', data));

        // Then: published to broadcast subject (prefix stripped)
        expect(mockJs.publish).toHaveBeenCalledWith(
          'broadcast.config.updated',
          codec.encode(data),
          expect.objectContaining({ headers: expect.anything() }),
        );
      });

      it('should publish ordered event to ordered subject', async () => {
        // Given: ordered-prefixed event
        const data = { status: faker.lorem.word() };

        // When: ordered event emitted
        await firstValueFrom(sut.emit('ordered:order.status', data));

        // Then: published to ordered subject (prefix stripped)
        expect(mockJs.publish).toHaveBeenCalledWith(
          `${targetName}__microservice.ordered.order.status`,
          codec.encode(data),
          expect.objectContaining({ headers: expect.anything() }),
        );
      });
    });

    describe('when using JetstreamRecord', () => {
      it('should extract data and custom headers from record', async () => {
        // Given: record with custom headers
        const data = { key: faker.lorem.word() };
        const traceId = faker.string.uuid();
        const record = new JetstreamRecordBuilder(data).setHeader('x-trace-id', traceId).build();

        // When: event emitted with record
        await firstValueFrom(sut.emit('user.updated', record));

        // Then: data extracted and headers merged
        expect(mockJs.publish).toHaveBeenCalledWith(
          expect.any(String),
          codec.encode(data),
          expect.objectContaining({ headers: expect.anything() }),
        );

        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;

        expect(publishedHeaders.get('x-trace-id')).toBe(traceId);
      });
    });

    describe('transport headers', () => {
      it('should set subject and caller-name headers', async () => {
        // When: event emitted
        await firstValueFrom(sut.emit('user.created', { test: true }));

        // Then: transport headers present
        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;

        expect(publishedHeaders.get(JetstreamHeader.Subject)).toBeTruthy();
        expect(publishedHeaders.get(JetstreamHeader.CallerName)).toBe(
          `${options.name}__microservice`,
        );
      });
    });

    describe('duplicate detection', () => {
      it('should log warning when JetStream returns a duplicate ack', async () => {
        // Given: publish returns duplicate: true
        mockJs.publish.mockResolvedValue({ stream: 'test', seq: 1, duplicate: true } as PubAck);

        const loggerWarnSpy = vi.spyOn(sut['logger'], 'warn');

        // When
        await firstValueFrom(sut.emit('order.created', { id: 1 }));

        // Then
        expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Duplicate'));
      });
    });

    describe('when using ttl()', () => {
      it('should pass ttl to publish options', async () => {
        // Given: record with TTL (30 seconds in nanos)
        const data = { token: faker.string.alphanumeric(32) };
        const record = new JetstreamRecordBuilder(data).ttl(30 * 1_000_000_000).build();

        mockJs.publish.mockResolvedValue(createMock<PubAck>({ duplicate: false }));

        // When
        await firstValueFrom(sut.emit('session.token', record));

        // Then: publish called with ttl option
        expect(mockJs.publish).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Uint8Array),
          expect.objectContaining({ ttl: '30s' }),
        );
      });
    });

    describe('when using scheduleAt()', () => {
      it('should publish to _sch subject in event stream with target set to event subject', async () => {
        // Given: record with schedule
        const data = { orderId: faker.number.int() };
        const futureDate = new Date(Date.now() + 60_000);
        const record = new JetstreamRecordBuilder(data).scheduleAt(futureDate).build();

        // When: event emitted with schedule
        await firstValueFrom(sut.emit('order.reminder', record));

        // Then: published to _sch namespace (not matched by consumer) with a
        // per-message unique suffix; ADR-51 allows one active schedule per subject
        const expectedScheduleSubject = new RegExp(
          `^${targetName}__microservice\\._sch\\.order\\.reminder\\.[A-Za-z0-9]+$`,
        );
        const expectedEventSubject = `${targetName}__microservice.ev.order.reminder`;

        expect(mockJs.publish).toHaveBeenCalledWith(
          expect.stringMatching(expectedScheduleSubject),
          codec.encode(data),
          expect.objectContaining({
            schedule: {
              specification: futureDate,
              target: expectedEventSubject,
            },
          }),
        );
      });

      it('should publish broadcast schedule to _sch subject with broadcast target', async () => {
        // Given: broadcast event with schedule
        const data = { config: faker.lorem.word() };
        const futureDate = new Date(Date.now() + 60_000);
        const record = new JetstreamRecordBuilder(data).scheduleAt(futureDate).build();

        // When: broadcast event emitted with schedule
        await firstValueFrom(sut.emit('broadcast:config.updated', record));

        // Then: published to broadcast._sch namespace with a unique suffix
        const expectedScheduleSubject = /^broadcast\._sch\.config\.updated\.[A-Za-z0-9]+$/;
        const expectedBroadcastTarget = 'broadcast.config.updated';

        expect(mockJs.publish).toHaveBeenCalledWith(
          expect.stringMatching(expectedScheduleSubject),
          codec.encode(data),
          expect.objectContaining({
            schedule: {
              specification: futureDate,
              target: expectedBroadcastTarget,
            },
          }),
        );
      });

      it('should resolve the schedule subject through the resolver for a self target with a custom prefix', async () => {
        // Given: self-targeted client with a custom event subjectPrefix
        const selfOptions: JetstreamModuleOptions = {
          ...options,
          events: { subjectPrefix: 'company.orders.' },
        };
        const names = new NameResolver(selfOptions);
        const selfSut = new JetstreamClient(
          selfOptions,
          selfOptions.name,
          connection,
          codec,
          eventBus,
          names,
        );

        const data = { orderId: faker.number.int() };
        const futureDate = new Date(Date.now() + 60_000);
        const record = new JetstreamRecordBuilder(data).scheduleAt(futureDate).build();

        // When: event emitted with schedule
        await firstValueFrom(selfSut.emit('order.reminder', record));

        // Then: holder lives under the custom prefix _sch namespace, target is the resolved subject
        const expectedScheduleSubject = /^company\.orders\._sch\.order\.reminder\.[A-Za-z0-9]+$/;

        expect(mockJs.publish).toHaveBeenCalledWith(
          expect.stringMatching(expectedScheduleSubject),
          codec.encode(data),
          expect.objectContaining({
            schedule: {
              specification: futureDate,
              target: 'company.orders.order.reminder',
            },
          }),
        );

        await selfSut.close();
      });

      it('should reject scheduleAt for ordered patterns', async () => {
        // Given: ordered event with schedule; the schedule holder would land
        // in the event stream while the target lives in the ordered stream,
        // which the server rejects (schedule target must share the stream)
        const data = { status: faker.lorem.word() };
        const futureDate = new Date(Date.now() + 60_000);
        const record = new JetstreamRecordBuilder(data).scheduleAt(futureDate).build();

        // When/Then: emit rejects with a descriptive error, nothing is published
        await expect(firstValueFrom(sut.emit('ordered:order.status', record))).rejects.toThrow(
          expect.objectContaining({
            name: 'JetstreamRecordError',
            reason: RecordErrorReason.ScheduleUnsupportedForOrdered,
            message: expect.stringMatching(/scheduleAt.*ordered/i),
          }),
        );

        expect(mockJs.publish).not.toHaveBeenCalled();
      });

      it('should apply ttl to the delivered message, not the schedule holder', async () => {
        // Given: a scheduled record with a per-message TTL
        const data = { orderId: faker.number.int() };
        const futureDate = new Date(Date.now() + 60_000);
        const record = new JetstreamRecordBuilder(data)
          .scheduleAt(futureDate)
          .ttl(30 * 1_000_000_000)
          .build();

        // When: event emitted with schedule + ttl
        await firstValueFrom(sut.emit('order.reminder', record));

        // Then: ttl rides on the schedule (Nats-Schedule-TTL); a top-level ttl
        // would become Nats-TTL on the holder and cancel the schedule on expiry
        const publishOpts = mockJs.publish.mock.calls[0]![2]!;

        expect(publishOpts.ttl).toBeUndefined();
        expect(publishOpts.schedule).toMatchObject({
          specification: futureDate,
          ttl: '30s',
        });
      });

      it('should use a distinct schedule subject for each message of the same pattern', async () => {
        // Given: two records scheduled on the same pattern
        const futureDate = new Date(Date.now() + 60_000);
        const recordA = new JetstreamRecordBuilder({ orderId: 1 }).scheduleAt(futureDate).build();
        const recordB = new JetstreamRecordBuilder({ orderId: 2 }).scheduleAt(futureDate).build();

        // When: both emitted while the first schedule would still be pending
        await firstValueFrom(sut.emit('order.reminder', recordA));
        await firstValueFrom(sut.emit('order.reminder', recordB));

        // Then: each publish used its own schedule subject (no rollup replacement)
        const subjects = mockJs.publish.mock.calls.map((call) => call[0]);

        expect(subjects).toHaveLength(2);
        expect(subjects[0]).not.toBe(subjects[1]);
      });

      it('should NOT include schedule in publish options when not set', async () => {
        // Given: record without schedule
        const data = { orderId: faker.number.int() };

        // When: event emitted without schedule
        await firstValueFrom(sut.emit('order.created', data));

        // Then: no schedule in publish opts
        const publishOpts = mockJs.publish.mock.calls[0]![2]!;

        expect(publishOpts.schedule).toBeUndefined();
      });
    });
  });

  describe('server capabilities', () => {
    beforeEach(() => {
      connection.getCapabilities.mockResolvedValue(new ServerCapabilities(1, 'n1 (NATS 2.11.0)'));
    });

    it('should refuse scheduleAt() on a server that would store the holder and never fire it', async () => {
      // Given
      const record = new JetstreamRecordBuilder({})
        .scheduleAt(new Date(Date.now() + 60_000))
        .build();

      // When / Then
      await expect(firstValueFrom(sut.emit('order.reminder', record))).rejects.toThrow(
        /scheduleAt\(\) needs NATS JetStream API level 2 \(NATS 2\.12 or newer\)/,
      );
      expect(mockJs.publish).not.toHaveBeenCalled();
    });

    it('should publish ttl() on a server that supports it', async () => {
      // Given
      const record = new JetstreamRecordBuilder({}).ttl(toNanos(5, 'seconds')).build();

      // When
      await firstValueFrom(sut.emit('order.created', record));

      // Then
      expect(mockJs.publish).toHaveBeenCalled();
    });

    it('should not ask the server for a plain emit', async () => {
      // When
      await firstValueFrom(sut.emit('order.created', {}));

      // Then
      expect(connection.getCapabilities).not.toHaveBeenCalled();
    });
  });

  describe('schedules', () => {
    it('should validate a dynamic schedule on the target before any I/O', async () => {
      await expect(
        sut.schedule('not.a.token', 'reminder.due', {}, { everySeconds: 60 }),
      ).rejects.toThrow(expect.objectContaining({ reason: ScheduleErrorReason.InvalidId }));
      await expect(sut.cancelSchedule('a b')).rejects.toThrow(
        expect.objectContaining({ reason: ScheduleErrorReason.InvalidId }),
      );
    });

    it('should look the schedule stream up under the target tick prefix', async () => {
      // Given a target without a schedule stream
      const jsm = createMock<JetStreamManager>();

      vi.mocked(jsm.streams.find).mockRejectedValue(
        new JetStreamApiError({
          err_code: NatsErrorCode.StreamNotFound,
          code: 404,
          description: 'no stream matches subject',
        }),
      );
      connection.getJetStreamManager.mockResolvedValue(jsm);

      // When / Then
      await expect(sut.listSchedules()).rejects.toThrow(`${targetName}__microservice.sched.`);
    });
  });

  describe('when the target declares custom subject prefixes', () => {
    let prefixes: TargetSubjectPrefixes;
    let prefixedSut: JetstreamClient;

    beforeEach(() => {
      prefixes = {
        events: `${faker.lorem.word()}.ev`,
        ordered: `${faker.lorem.word()}.ord`,
        rpc: `${faker.lorem.word()}.rpc`,
      };
      prefixedSut = new JetstreamClient(
        options,
        targetName,
        connection,
        codec,
        eventBus,
        undefined,
        prefixes,
      );
    });

    afterEach(async () => {
      await prefixedSut.close();
    });

    it('should publish events under the target events prefix', async () => {
      // Given
      const data = { id: faker.number.int() };

      // When
      await firstValueFrom(prefixedSut.emit('order.created', data));

      // Then
      expect(mockJs.publish).toHaveBeenCalledWith(
        `${prefixes.events}.order.created`,
        codec.encode(data),
        expect.anything(),
      );
    });

    it('should publish ordered events under the target ordered prefix', async () => {
      // Given
      const data = { id: faker.number.int() };

      // When
      await firstValueFrom(prefixedSut.emit('ordered:order.status', data));

      // Then
      expect(mockJs.publish).toHaveBeenCalledWith(
        `${prefixes.ordered}.order.status`,
        codec.encode(data),
        expect.anything(),
      );
    });

    it('should send commands under the target rpc prefix', async () => {
      // Given a responding server
      mockNc.request.mockResolvedValue(
        createMock<Msg>({ data: codec.encode({ ok: true }), headers: natsHeaders() }),
      );

      // When
      await firstValueFrom(prefixedSut.send('get.asset', {}));

      // Then
      expect(mockNc.request).toHaveBeenCalledWith(
        `${prefixes.rpc}.get.asset`,
        expect.any(Uint8Array),
        expect.anything(),
      );
    });

    it('should place a scheduled event holder in the target custom schedule namespace', async () => {
      // Given
      const data = { id: faker.number.int() };
      const at = new Date(Date.now() + 60_000);
      const record = new JetstreamRecordBuilder(data).scheduleAt(at).build();

      // When
      await firstValueFrom(prefixedSut.emit('order.reminder', record));

      // Then
      expect(mockJs.publish).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^${prefixes.events}\\._sch\\.order\\.reminder\\.\\w+$`)),
        codec.encode(data),
        expect.objectContaining({
          schedule: { specification: at, target: `${prefixes.events}.order.reminder` },
        }),
      );
    });

    it('should keep the convention for kinds the target leaves out', async () => {
      // Given a target with only an events prefix
      const partialSut = new JetstreamClient(
        options,
        targetName,
        connection,
        codec,
        eventBus,
        undefined,
        { events: prefixes.events },
      );

      // When
      await firstValueFrom(partialSut.emit('ordered:order.status', {}));

      // Then
      expect(mockJs.publish).toHaveBeenCalledWith(
        `${targetName}__microservice.ordered.order.status`,
        expect.anything(),
        expect.anything(),
      );

      await partialSut.close();
    });

    it("should schedule a broadcast under the caller's own broadcast prefix", async () => {
      // Given a caller with a custom broadcast prefix publishing through a foreign-target client
      const broadcastPrefix = `${faker.lorem.word()}.bc`;
      const callerOptions: JetstreamModuleOptions = {
        ...options,
        broadcast: { subjectPrefix: broadcastPrefix },
      };
      const callerSut = new JetstreamClient(
        callerOptions,
        targetName,
        connection,
        codec,
        eventBus,
        new NameResolver(callerOptions),
        prefixes,
      );
      const at = new Date(Date.now() + 60_000);
      const record = new JetstreamRecordBuilder({}).scheduleAt(at).build();

      // When
      await firstValueFrom(callerSut.emit('broadcast:config.updated', record));

      // Then the holder and the target both follow the caller's broadcast prefix
      expect(mockJs.publish).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^${broadcastPrefix}\\._sch\\.config\\.updated\\.\\w+$`)),
        expect.anything(),
        expect.objectContaining({
          schedule: { specification: at, target: `${broadcastPrefix}.config.updated` },
        }),
      );

      await callerSut.close();
    });

    it('should reject prefixes for a client that targets the service itself', () => {
      // When / Then
      expect(
        () =>
          new JetstreamClient(options, options.name, connection, codec, eventBus, undefined, {
            events: prefixes.events,
          }),
      ).toThrow(
        expect.objectContaining({
          name: 'JetstreamConfigError',
          reason: ConfigErrorReason.SelfTargetPrefix,
          message: expect.stringMatching(/targets this service itself/),
        }),
      );
    });

    it('should reject an invalid prefix when the client is created', () => {
      // When / Then
      expect(
        () =>
          new JetstreamClient(options, targetName, connection, codec, eventBus, undefined, {
            rpc: 'acme.>',
          }),
      ).toThrow(
        expect.objectContaining({
          name: 'JetstreamConfigError',
          reason: ConfigErrorReason.InvalidSubjectPrefix,
          message: expect.stringMatching(/Invalid subjectPrefix "acme\.>"/),
        }),
      );
    });
  });

  describe('send() / publish(); core RPC mode', () => {
    describe('happy path', () => {
      it('should send request via nc.request() and return decoded response', async () => {
        // Given: server responds successfully
        const responseData = { id: faker.number.int() };
        const responseHeaders = natsHeaders();

        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode(responseData),
            headers: responseHeaders,
          }),
        );

        // When: RPC sent
        const result = await firstValueFrom(sut.send('get.user', { userId: 1 }));

        // Then: response decoded and returned
        expect(result).toEqual(responseData);
        expect(mockNc.request).toHaveBeenCalledWith(
          `${targetName}__microservice.cmd.get.user`,
          expect.any(Uint8Array),
          expect.objectContaining({
            timeout: DEFAULT_RPC_TIMEOUT,
            headers: expect.anything(),
          }),
        );
      });

      it('should resolve without error on success', async () => {
        // Given: successful response
        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode({ ok: true }),
            headers: natsHeaders(),
          }),
        );

        // When: RPC sent
        const result = await firstValueFrom(sut.send('get.user', {}));

        // Then: result decoded
        expect(result).toEqual({ ok: true });
      });
    });

    describe('when response has x-error header', () => {
      it('should emit error through the observable', async () => {
        // Given: server responds with error
        const errorPayload = { statusCode: 404, message: 'Not found' };
        const errorHeaders = natsHeaders();

        errorHeaders.set(JetstreamHeader.Error, 'true');

        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode(errorPayload),
            headers: errorHeaders,
          }),
        );

        // When/Then: observable emits error
        await expect(firstValueFrom(sut.send('get.user', { id: 1 }))).rejects.toEqual(errorPayload);
      });
    });

    describe('when custom timeout is provided via options', () => {
      it('should use the configured timeout', async () => {
        // Given: custom timeout in options
        const customTimeout = faker.number.int({ min: 1000, max: 5000 });

        options.rpc = { mode: 'core', timeout: customTimeout };
        sut = new JetstreamClient(options, targetName, connection, codec, eventBus);

        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode({}),
            headers: natsHeaders(),
          }),
        );

        // When: RPC sent
        await firstValueFrom(sut.send('test', {}));

        // Then: custom timeout used
        expect(mockNc.request).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Uint8Array),
          expect.objectContaining({ timeout: customTimeout }),
        );
      });
    });

    describe('when custom timeout is provided via JetstreamRecord', () => {
      it('should use the per-message timeout', async () => {
        // Given: record with custom timeout
        const perMessageTimeout = faker.number.int({ min: 100, max: 1000 });
        const record = new JetstreamRecordBuilder({ test: true })
          .setTimeout(perMessageTimeout)
          .build();

        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode({}),
            headers: natsHeaders(),
          }),
        );

        // When: RPC sent with record
        await firstValueFrom(sut.send('test', record));

        // Then: per-message timeout used
        expect(mockNc.request).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Uint8Array),
          expect.objectContaining({ timeout: perMessageTimeout }),
        );
      });
    });

    describe('error paths', () => {
      it('should reject with Error instance when nc.request() throws', async () => {
        // Given: request fails
        mockNc.request.mockRejectedValue(new Error('request timeout'));

        // When/Then: observable rejects with Error instance
        await expect(firstValueFrom(sut.send('test', {}))).rejects.toThrow('request timeout');
      });

      it('should reject with Error instance for non-Error throw', async () => {
        // Given: request fails with non-Error
        mockNc.request.mockRejectedValue('some string error');

        // When/Then: wrapped in Error
        await expect(firstValueFrom(sut.send('test', {}))).rejects.toThrow('Unknown error');
      });

      it('should keep the encoding failure as the cause of an internal transport error', async () => {
        // Given: the codec cannot encode the payload
        const encodeError = new Error(faker.lorem.sentence());

        vi.mocked(codec.encode).mockImplementation(() => {
          throw encodeError;
        });

        // When/Then
        await expect(firstValueFrom(sut.send('test', {}))).rejects.toThrow(
          expect.objectContaining({
            name: 'JetstreamRpcError',
            reason: RpcErrorReason.InternalTransport,
            cause: encodeError,
          }),
        );
      });

      it('should emit TransportEvent.Error on request failure', async () => {
        // Given: request fails
        mockNc.request.mockRejectedValue(new Error('request timeout'));

        // When: RPC attempted
        try {
          await firstValueFrom(sut.send('test', {}));
        } catch {
          // expected
        }

        await new Promise(process.nextTick);

        // Then: error event emitted
        expect(eventBus.emit).toHaveBeenCalledWith(
          TransportEvent.Error,
          expect.any(Error),
          'client-rpc',
        );
      });
    });

    describe('when record has scheduleAt()', () => {
      it('should log warning and ignore schedule', async () => {
        // Given: record with schedule, successful RPC response
        const futureDate = new Date(Date.now() + 60_000);
        const record = new JetstreamRecordBuilder({ test: true }).scheduleAt(futureDate).build();

        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode({ ok: true }),
            headers: natsHeaders(),
          }),
        );

        const loggerWarnSpy = vi.spyOn(sut['logger'], 'warn');

        // When: RPC sent with scheduled record
        const result = await firstValueFrom(sut.send('get.user', record));

        // Then: warning logged
        expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduleAt()'));

        // Then: RPC still completes successfully
        expect(result).toEqual({ ok: true });
      });
    });

    describe('when record has ttl()', () => {
      it('should log warning and ignore TTL for RPC', async () => {
        // Given: record with TTL
        const record = new JetstreamRecordBuilder({ test: true }).ttl(30 * 1_000_000_000).build();

        mockNc.request.mockResolvedValue(
          createMock<Msg>({
            data: codec.encode({ ok: true }),
            headers: natsHeaders(),
          }),
        );

        const loggerWarnSpy = vi.spyOn(sut['logger'], 'warn');

        // When
        const result = await firstValueFrom(sut.send('get.user', record));

        // Then: warning logged
        expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('ttl()'));

        // And: TTL not passed to NATS request (Core RPC uses nc.request, not JetStream publish)
        expect(mockNc.request).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Uint8Array),
          expect.not.objectContaining({ ttl: expect.anything() }),
        );

        // And: RPC still works
        expect(result).toEqual({ ok: true });
      });
    });
  });

  describe('send() / publish(); jetstream RPC mode', () => {
    let inboxCallback: (err: Error | null, msg: Msg) => void;

    beforeEach(async () => {
      vi.useFakeTimers();

      options.rpc = { mode: 'jetstream' };
      sut = new JetstreamClient(options, targetName, connection, codec, eventBus);

      await sut.connect();

      // Capture inbox subscription callback
      inboxCallback = mockNc.subscribe.mock.calls[0]![1]!.callback! as (
        err: Error | null,
        msg: Msg,
      ) => void;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('happy path', () => {
      it('should publish command to JetStream and resolve via inbox reply', async () => {
        // Given: a response that will arrive via inbox
        const responseData = { id: faker.number.int() };

        // When: RPC sent
        const resultPromise = firstValueFrom(sut.send('get.user', { userId: 1 }));

        // Allow publish to complete
        await vi.advanceTimersByTimeAsync(0);

        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;
        const correlationId = publishedHeaders.get(JetstreamHeader.CorrelationId);

        const replyHeaders = natsHeaders();

        replyHeaders.set(JetstreamHeader.CorrelationId, correlationId);

        inboxCallback(
          null,
          createMock<Msg>({
            data: codec.encode(responseData),
            headers: replyHeaders,
          }),
        );

        // Then: resolved with response
        const result = await resultPromise;

        expect(result).toEqual(responseData);
      });

      it('should set replyTo and correlationId headers on published message', async () => {
        // When: RPC sent
        const resultPromise = firstValueFrom(sut.send('get.user', {}));

        await vi.advanceTimersByTimeAsync(0);

        // Then: transport headers include replyTo and correlationId
        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;

        expect(publishedHeaders.get(JetstreamHeader.ReplyTo)).toBeTruthy();
        expect(publishedHeaders.get(JetstreamHeader.CorrelationId)).toBeTruthy();

        // Cleanup: resolve the pending promise
        const correlationId = publishedHeaders.get(JetstreamHeader.CorrelationId);
        const replyHeaders = natsHeaders();

        replyHeaders.set(JetstreamHeader.CorrelationId, correlationId);
        inboxCallback(
          null,
          createMock<Msg>({
            data: codec.encode({}),
            headers: replyHeaders,
          }),
        );
        await resultPromise;
      });
    });

    describe('when inbox reply has x-error header', () => {
      it('should emit error through the observable', async () => {
        // Given: error response will arrive
        const errorPayload = { statusCode: 500, message: 'Internal error' };

        // When: RPC sent
        const resultPromise = firstValueFrom(sut.send('test', {}));

        await vi.advanceTimersByTimeAsync(0);

        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;
        const correlationId = publishedHeaders.get(JetstreamHeader.CorrelationId);
        const replyHeaders = natsHeaders();

        replyHeaders.set(JetstreamHeader.CorrelationId, correlationId);
        replyHeaders.set(JetstreamHeader.Error, 'true');

        inboxCallback(
          null,
          createMock<Msg>({
            data: codec.encode(errorPayload),
            headers: replyHeaders,
          }),
        );

        // Then: observable errors
        await expect(resultPromise).rejects.toEqual(errorPayload);
      });
    });

    describe('when handler times out', () => {
      it('should reject with Error instance on timeout', async () => {
        // When: RPC sent (no reply will come)
        const resultPromise = firstValueFrom(sut.send('slow.handler', {}));

        await vi.advanceTimersByTimeAsync(0);

        vi.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT);

        // Then: timeout error surfaces the unified `rpc.timeout` label
        await expect(resultPromise).rejects.toThrow(
          expect.objectContaining({
            name: 'JetstreamRpcError',
            reason: RpcErrorReason.Timeout,
            message: 'rpc.timeout',
          }),
        );
        expect(eventBus.emit).toHaveBeenCalledWith(
          TransportEvent.RpcTimeout,
          expect.stringContaining('cmd.slow.handler'),
          expect.any(String),
        );
      });
    });

    describe('when teardown function is called', () => {
      it('should clean up pending message and timeout', async () => {
        // When: subscribe and immediately unsubscribe
        const subscription = sut.send('test', {}).subscribe({
          next: () => {},
          error: () => {},
        });

        await vi.advanceTimersByTimeAsync(0);
        subscription.unsubscribe();

        // Then: advancing time should NOT trigger timeout callback
        // (timeout was cleared by teardown)
        vi.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT);

        expect(eventBus.emit).not.toHaveBeenCalledWith(
          TransportEvent.RpcTimeout,
          expect.anything(),
          expect.anything(),
        );
      });
    });

    describe('inbox edge cases', () => {
      it('should ignore inbox reply without correlation-id', async () => {
        // When/Then: inbox reply arrives without correlation-id, no crash
        expect(() => {
          inboxCallback(
            null,
            createMock<Msg>({
              data: codec.encode({}),
              headers: natsHeaders(), // no correlation-id set
            }),
          );
        }).not.toThrow();
      });

      it('should ignore inbox reply for unknown correlation-id', async () => {
        // When: inbox reply arrives for non-pending correlation-id
        const replyHeaders = natsHeaders();

        replyHeaders.set(JetstreamHeader.CorrelationId, faker.string.uuid());

        // Then: no crash
        expect(() => {
          inboxCallback(
            null,
            createMock<Msg>({
              data: codec.encode({}),
              headers: replyHeaders,
            }),
          );
        }).not.toThrow();
      });

      it('should handle inbox subscription error without crashing', () => {
        // When/Then: inbox subscription emits error without crash
        expect(() => {
          inboxCallback(new Error('subscription error'), createMock<Msg>());
        }).not.toThrow();
      });

      it('should reject with Error instance on decode failure in inbox reply', async () => {
        // Given: pending RPC
        const resultPromise = firstValueFrom(sut.send('test', {}));

        await vi.advanceTimersByTimeAsync(0);

        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;
        const correlationId = publishedHeaders.get(JetstreamHeader.CorrelationId);

        // Given: codec will throw on decode
        codec.decode.mockImplementation(() => {
          throw new Error('invalid payload');
        });

        // When: inbox reply arrives
        const replyHeaders = natsHeaders();

        replyHeaders.set(JetstreamHeader.CorrelationId, correlationId);

        inboxCallback(
          null,
          createMock<Msg>({
            data: new Uint8Array([0xff]),
            headers: replyHeaders,
          }),
        );

        // Then: error propagated as Error instance
        await expect(resultPromise).rejects.toThrow('invalid payload');
      });

      it('should reject with a typed decode error when the codec throws a non-Error', async () => {
        // Given
        const resultPromise = firstValueFrom(sut.send('test', {}));

        await vi.advanceTimersByTimeAsync(0);

        const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;
        const replyHeaders = natsHeaders();

        replyHeaders.set(
          JetstreamHeader.CorrelationId,
          publishedHeaders.get(JetstreamHeader.CorrelationId),
        );
        codec.decode.mockImplementation(() => {
          throw 'invalid payload';
        });

        // When
        inboxCallback(
          null,
          createMock<Msg>({ data: new Uint8Array([0xff]), headers: replyHeaders }),
        );

        // Then
        await expect(resultPromise).rejects.toThrow(
          expect.objectContaining({
            name: 'JetstreamRpcError',
            reason: RpcErrorReason.DecodeFailed,
            message: 'Decode error',
          }),
        );
      });
    });

    describe('error paths', () => {
      it('should reject with Error instance when js.publish() fails', async () => {
        // Given: publish will fail
        mockJs.publish.mockRejectedValue(new Error('stream not found'));

        // When/Then: error propagated as Error instance
        const errorPromise = new Promise<unknown>((resolve) => {
          sut.send('test', {}).subscribe({ error: resolve });
        });

        await vi.advanceTimersByTimeAsync(10);

        const err = await errorPromise;

        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('stream not found');
      });
    });
  });

  describe('getRpcTimeout() behavior', () => {
    it('should default to DEFAULT_RPC_TIMEOUT when no rpc config', async () => {
      // Given: no rpc config (core mode implied)
      mockNc.request.mockResolvedValue(
        createMock<Msg>({ data: codec.encode({}), headers: natsHeaders() }),
      );

      // When: RPC sent
      await firstValueFrom(sut.send('test', {}));

      // Then: default core timeout used
      expect(mockNc.request).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Uint8Array),
        expect.objectContaining({ timeout: DEFAULT_RPC_TIMEOUT }),
      );
    });

    it('should use DEFAULT_JETSTREAM_RPC_TIMEOUT in jetstream mode', async () => {
      vi.useFakeTimers();

      // Given: jetstream rpc mode without explicit timeout
      options.rpc = { mode: 'jetstream' };
      sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
      await sut.connect();

      // When: send an RPC (timeout will fire since no reply comes)
      const resultPromise = firstValueFrom(sut.send('test', {}));

      await vi.advanceTimersByTimeAsync(0);

      // Advance to just before the timeout: should NOT have fired yet
      vi.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT - 1);
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        TransportEvent.RpcTimeout,
        expect.anything(),
        expect.anything(),
      );

      // Advance past the timeout: should fire
      vi.advanceTimersByTime(1);
      expect(eventBus.emit).toHaveBeenCalledWith(
        TransportEvent.RpcTimeout,
        expect.anything(),
        expect.anything(),
      );

      try {
        await resultPromise;
      } catch {
        // expected
      }

      vi.useRealTimers();
    });
  });

  describe('duplicate publish detection (JetStream RPC mode)', () => {
    beforeEach(async () => {
      vi.useFakeTimers();

      options.rpc = { mode: 'jetstream' };
      sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
      await sut.connect();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should fail fast when the command publish is deduplicated by the stream', async () => {
      // Given: the stream reports the publish as a duplicate; the original
      // command owns the reply, this correlation id will never receive one
      mockJs.publish.mockResolvedValue(createMock<PubAck>({ duplicate: true, seq: 5 }));

      // When: sending an RPC whose messageId was already used
      const result = firstValueFrom(sut.send('rpc.dup', {}));
      // Attach the expectation before the rejection settles; awaited below
      // oxlint-disable-next-line vitest/valid-expect
      const assertion = expect(result).rejects.toThrow(
        expect.objectContaining({
          name: 'JetstreamRpcError',
          reason: RpcErrorReason.DuplicatePublish,
          message: expect.stringMatching(/duplicate/i),
        }),
      );

      await vi.advanceTimersByTimeAsync(0);

      // Then: rejected immediately instead of hanging until the RPC timeout
      await vi.advanceTimersByTimeAsync(DEFAULT_JETSTREAM_RPC_TIMEOUT);
      await assertion;
    });

    it('should reject with JetstreamPublishError when the command stream is full', async () => {
      // Given
      mockJs.publish.mockRejectedValue(
        new JetStreamApiError({
          err_code: 10077,
          code: 503,
          description: 'maximum bytes exceeded',
        }),
      );

      // When
      const result = firstValueFrom(sut.send('rpc.full', {}));
      // oxlint-disable-next-line vitest/valid-expect
      const assertion = expect(result).rejects.toThrow(
        expect.objectContaining({
          name: 'JetstreamPublishError',
          reason: PublishErrorReason.StreamFull,
          message: 'maximum bytes exceeded',
        }),
      );

      await vi.advanceTimersByTimeAsync(0);

      // Then
      await assertion;
    });
  });

  describe('connection status handling (JetStream RPC mode)', () => {
    let inboxCallback: (err: Error | null, msg: Msg) => void;

    const replyTo = (callIndex: number, payload: unknown): void => {
      const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[callIndex]![2]!.headers!;
      const replyHeaders = natsHeaders();

      replyHeaders.set(
        JetstreamHeader.CorrelationId,
        publishedHeaders.get(JetstreamHeader.CorrelationId),
      );
      inboxCallback(null, createMock<Msg>({ data: codec.encode(payload), headers: replyHeaders }));
    };

    beforeEach(async () => {
      vi.useFakeTimers();

      options.rpc = { mode: 'jetstream' };
      sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
      await sut.connect();

      inboxCallback = mockNc.subscribe.mock.calls[0]![1]!.callback! as (
        err: Error | null,
        msg: Msg,
      ) => void;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should deliver the reply to a call that was pending across a disconnect', async () => {
      // Given a pending call
      const reply = { id: faker.string.uuid() };
      const result = firstValueFrom(sut.send('rpc.one', {}));

      await vi.advanceTimersByTimeAsync(0);

      // When the connection drops and the persisted command is answered after the reconnect
      statusSubject.next({ type: 'disconnect', server: '' });
      statusSubject.next({ type: 'reconnect', server: '' });
      replyTo(0, reply);

      // Then the caller gets the reply instead of a ConnectionLost it might retry
      await expect(result).resolves.toEqual(reply);
    });

    it('should keep the inbox subscription across a disconnect', async () => {
      // Given the inbox subscription
      const inbox = mockNc.subscribe.mock.results[0]!.value as Mocked<Subscription>;

      // When the connection drops and the client is used again
      statusSubject.next({ type: 'disconnect', server: '' });
      await sut.connect();

      // Then nats.js keeps resubscribing the same inbox
      expect(inbox.unsubscribe).not.toHaveBeenCalled();
      expect(mockNc.subscribe).toHaveBeenCalledTimes(1);
    });

    it('should bound a call pending across a disconnect by its deadline', async () => {
      // Given a pending call
      const result = firstValueFrom(sut.send('rpc.one', {}));

      await vi.advanceTimersByTimeAsync(0);

      // When the connection drops and no reply arrives
      statusSubject.next({ type: 'disconnect', server: '' });
      vi.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT);

      // Then the call times out
      await expect(result).rejects.toThrow(
        expect.objectContaining({ name: 'JetstreamRpcError', reason: RpcErrorReason.Timeout }),
      );
    });

    it('should reject every pending call with ConnectionLost when the connection closes', async () => {
      // Given two pending calls
      const result1 = firstValueFrom(sut.send('rpc.one', {}));
      const result2 = firstValueFrom(sut.send('rpc.two', {}));

      await vi.advanceTimersByTimeAsync(0);

      // When the connection closes for good
      statusSubject.next({ type: 'close' } as Status);

      // Then both fail fast
      const connectionLost = expect.objectContaining({
        name: 'JetstreamRpcError',
        reason: RpcErrorReason.ConnectionLost,
        message: 'Connection lost',
      });

      await expect(result1).rejects.toThrow(connectionLost);
      await expect(result2).rejects.toThrow(connectionLost);
    });

    it('should clear the deadlines of the calls it rejects on close', async () => {
      // Given a pending call
      firstValueFrom(sut.send('rpc.one', {})).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // When the connection closes
      statusSubject.next({ type: 'close' } as Status);

      // Then its deadline never fires
      vi.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT);
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        TransportEvent.RpcTimeout,
        expect.anything(),
        expect.anything(),
      );
    });

    it('should open a new inbox on the next connect after the connection closes', async () => {
      // Given the inbox of the closed connection
      statusSubject.next({ type: 'close' } as Status);

      // When the client connects again
      await sut.connect();

      // Then a fresh inbox subscription is created
      expect(mockNc.subscribe).toHaveBeenCalledTimes(2);
    });

    it('should reject pending callbacks when the client closes', async () => {
      // Given: a pending RPC
      const result = firstValueFrom(sut.send('rpc.one', {}));

      await vi.advanceTimersByTimeAsync(0);

      // When
      await sut.close();

      // Then
      await expect(result).rejects.toThrow(
        expect.objectContaining({
          name: 'JetstreamRpcError',
          reason: RpcErrorReason.ClientClosed,
          message: 'Client closed',
        }),
      );
    });

    it('should not affect core RPC mode on disconnect or close', async () => {
      // Given: core mode client
      options.rpc = undefined;
      const coreClient = new JetstreamClient(options, targetName, connection, codec, eventBus);

      await coreClient.connect();

      // When/Then: status changes fire, no crash
      expect(() => {
        statusSubject.next({ type: 'disconnect', server: '' });
        statusSubject.next({ type: 'close' } as Status);
      }).not.toThrow();

      await coreClient.close();
    });
  });

  describe('cancellation (JetStream RPC mode)', () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      eventBus.hasHook.mockReturnValue(true);

      options.rpc = { mode: 'jetstream' };
      sut = new JetstreamClient(options, targetName, connection, codec, eventBus);
      await sut.connect();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should report a call the caller unsubscribed from as cancelled', async () => {
      // Given a pending call
      const subscription = sut.send('rpc.one', {}).subscribe({ error: () => {} });

      await vi.advanceTimersByTimeAsync(0);

      // When the caller gives up on it
      subscription.unsubscribe();

      // Then the round-trip settles once, as cancelled
      const completed = eventBus.emit.mock.calls.filter(
        (c) => c[0] === TransportEvent.RpcCompleted,
      );

      expect(completed).toEqual([
        [TransportEvent.RpcCompleted, 'rpc.one', expect.any(Number), 'cancelled'],
      ]);
    });

    it('should not report a call answered by its handler as cancelled', async () => {
      // Given a pending call
      const inboxCallback = mockNc.subscribe.mock.calls[0]![1]!.callback! as (
        err: Error | null,
        msg: Msg,
      ) => void;
      const result = firstValueFrom(sut.send('rpc.one', {}));

      await vi.advanceTimersByTimeAsync(0);

      const publishedHeaders: MsgHdrs = mockJs.publish.mock.calls[0]![2]!.headers!;
      const replyHeaders = natsHeaders();

      replyHeaders.set(
        JetstreamHeader.CorrelationId,
        publishedHeaders.get(JetstreamHeader.CorrelationId),
      );

      // When the reply completes the observable, which runs its teardown
      inboxCallback(null, createMock<Msg>({ data: codec.encode({}), headers: replyHeaders }));
      await result;

      // Then only the success is reported
      const statuses = eventBus.emit.mock.calls
        .filter((c) => c[0] === TransportEvent.RpcCompleted)
        .map((c) => c[3]);

      expect(statuses).toEqual(['success']);
    });

    it('should not report a call that already settled as cancelled', async () => {
      // Given a call that timed out
      const subscription = sut.send('rpc.one', {}).subscribe({ error: () => {} });

      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(DEFAULT_JETSTREAM_RPC_TIMEOUT);

      // When the caller unsubscribes afterwards
      subscription.unsubscribe();

      // Then only the timeout is reported
      const statuses = eventBus.emit.mock.calls
        .filter((c) => c[0] === TransportEvent.RpcCompleted)
        .map((c) => c[3]);

      expect(statuses).toEqual(['timeout']);
    });
  });

  describe('Published / RpcCompleted emission', () => {
    const findEmit = (event: TransportEvent): unknown[] | undefined =>
      eventBus.emit.mock.calls.find((c) => c[0] === event);

    beforeEach(() => {
      eventBus.hasHook.mockReturnValue(true);
    });

    describe('event publishes', () => {
      it('should emit Published with kind=Event and status=success for a workqueue publish', async () => {
        // Given/When
        await firstValueFrom(sut.emit('user.created', { id: 1 }));

        // Then
        const call = findEmit(TransportEvent.Published);

        expect(call).toBeDefined();
        expect(call![1]).toBe('user.created');
        expect(call![2]).toBe('ev');
        expect(typeof call![3]).toBe('number');
        expect(call![4]).toBe('success');
      });

      it.each([
        ['broadcast:config.updated', 'config.updated', 'broadcast'],
        ['ordered:order.status', 'order.status', 'ordered'],
      ])('should strip the prefix from %s -> %s (kind=%s)', async (pattern, declared, kind) => {
        // Given/When
        await firstValueFrom(sut.emit(pattern, {}));

        // Then
        const call = findEmit(TransportEvent.Published);

        expect(call![1]).toBe(declared);
        expect(call![2]).toBe(kind);
      });

      it('should emit Published with status=error when the JetStream publish fails', async () => {
        // Given
        mockJs.publish.mockRejectedValueOnce(new Error('stream not found'));

        // When
        await expect(firstValueFrom(sut.emit('user.created', {}))).rejects.toThrow(
          'stream not found',
        );

        // Then
        const call = findEmit(TransportEvent.Published);

        expect(call![4]).toBe('error');
      });

      it('should skip emission entirely when no listener is registered (hot-path guard)', async () => {
        // Given
        eventBus.hasHook.mockReturnValue(false);

        // When
        await firstValueFrom(sut.emit('user.created', {}));

        // Then
        expect(findEmit(TransportEvent.Published)).toBeUndefined();
      });
    });

    describe('Core RPC', () => {
      it('should emit Published(kind=Command, success) and RpcCompleted(success) on a successful reply', async () => {
        // Given
        const reply = createMock<Msg>({
          data: codec.encode({ ok: true }),
          headers: natsHeaders(),
        });

        mockNc.request.mockResolvedValue(reply);

        // When
        await firstValueFrom(sut.send('orders.get', { id: 1 }));

        // Then
        const published = findEmit(TransportEvent.Published);
        const completed = findEmit(TransportEvent.RpcCompleted);

        expect(published).toBeDefined();
        expect(published![1]).toBe('orders.get');
        expect(published![2]).toBe('cmd');
        expect(published![4]).toBe('success');

        expect(completed).toBeDefined();
        expect(completed![1]).toBe('orders.get');
        expect(completed![3]).toBe('success');
      });

      it('should emit RpcCompleted(error) when the reply carries the error header', async () => {
        // Given
        const errorHdrs = natsHeaders();

        errorHdrs.set(JetstreamHeader.Error, 'true');
        const reply = createMock<Msg>({
          data: codec.encode({ message: 'bad' }),
          headers: errorHdrs,
        });

        mockNc.request.mockResolvedValue(reply);

        // When
        await firstValueFrom(sut.send('orders.get', {})).catch(() => undefined);

        // Then
        const completed = findEmit(TransportEvent.RpcCompleted);

        expect(completed![3]).toBe('error');
      });

      it('should emit RpcCompleted(timeout) when nc.request rejects with TimeoutError', async () => {
        // Given
        const { TimeoutError } = await import('@nats-io/transport-node');

        mockNc.request.mockRejectedValue(new TimeoutError());

        // When
        await firstValueFrom(sut.send('orders.get', {})).catch(() => undefined);

        // Then
        const completed = findEmit(TransportEvent.RpcCompleted);

        expect(completed![3]).toBe('timeout');
      });
    });
  });

  describe('self-RPC subject routing', () => {
    it('should publish send() to the resolver subject when targeting self with custom rpc.subjectPrefix', async () => {
      // Given: self-target client, custom command prefix, jetstream RPC mode
      vi.useFakeTimers();

      const selfOptions: JetstreamModuleOptions = {
        name: 'orders',
        servers: ['nats://localhost:4222'],
        rpc: { mode: 'jetstream', subjectPrefix: 'company.cmd.' },
      };
      const selfNames = new NameResolver(selfOptions);

      sut = new JetstreamClient(selfOptions, 'orders', connection, codec, eventBus, selfNames);
      await sut.connect();

      // When: RPC sent to self
      firstValueFrom(sut.send('do.x', {})).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // Then: published under the custom command prefix, not the convention
      expect(mockJs.publish).toHaveBeenCalledWith(
        'company.cmd.do.x',
        expect.anything(),
        expect.anything(),
      );

      vi.useRealTimers();
    });

    it('should keep the convention command subject for foreign targets', async () => {
      // Given: own service has custom rpc prefix; client targets a DIFFERENT service
      vi.useFakeTimers();

      const selfOptions: JetstreamModuleOptions = {
        name: 'orders',
        servers: ['nats://localhost:4222'],
        rpc: { mode: 'jetstream', subjectPrefix: 'company.cmd.' },
      };

      sut = new JetstreamClient(selfOptions, 'other-svc', connection, codec, eventBus);
      await sut.connect();

      // When: RPC sent to foreign target
      firstValueFrom(sut.send('do.y', {})).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // Then: uses convention subject for the foreign service
      expect(mockJs.publish).toHaveBeenCalledWith(
        'other-svc__microservice.cmd.do.y',
        expect.anything(),
        expect.anything(),
      );

      vi.useRealTimers();
    });
  });

  describe('broadcast subject routing', () => {
    it('should publish emit() broadcast under the custom broadcast.subjectPrefix', async () => {
      // Given: own service has a custom broadcast prefix
      const selfOptions: JetstreamModuleOptions = {
        name: 'orders',
        servers: ['nats://localhost:4222'],
        broadcast: { subjectPrefix: 'company.bc.' },
      };
      const selfNames = new NameResolver(selfOptions);

      sut = new JetstreamClient(selfOptions, 'orders', connection, codec, eventBus, selfNames);
      await sut.connect();

      // When: broadcast event emitted
      await firstValueFrom(sut.emit('broadcast:config.updated', {}));

      // Then: published under the custom broadcast prefix
      expect(mockJs.publish).toHaveBeenCalledWith(
        'company.bc.config.updated',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('self vs foreign subject routing', () => {
    it('should publish self events under the custom subjectPrefix', async () => {
      // Given: own service has a custom events.subjectPrefix; client targets itself
      const selfOptions: JetstreamModuleOptions = {
        name: 'orders',
        servers: ['nats://localhost:4222'],
        events: { subjectPrefix: 'company.orders.' },
      };

      sut = new JetstreamClient(selfOptions, 'orders', connection, codec, eventBus);
      await sut.connect();

      // When: event emitted to self
      await firstValueFrom(sut.emit('order.created', {}));

      // Then: published under the custom prefix, not the convention
      expect(mockJs.publish).toHaveBeenCalledWith(
        'company.orders.order.created',
        expect.anything(),
        expect.anything(),
      );
    });

    it('should keep the convention subject for foreign targets regardless of own prefix', async () => {
      // Given: own service has custom prefix; client targets a DIFFERENT service
      const selfOptions: JetstreamModuleOptions = {
        name: 'orders',
        servers: ['nats://localhost:4222'],
        events: { subjectPrefix: 'company.orders.' },
      };

      sut = new JetstreamClient(selfOptions, 'other-svc', connection, codec, eventBus);
      await sut.connect();

      // When: event emitted to foreign target
      await firstValueFrom(sut.emit('x', {}));

      // Then: uses convention subject for the foreign service
      expect(mockJs.publish).toHaveBeenCalledWith(
        'other-svc__microservice.ev.x',
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
