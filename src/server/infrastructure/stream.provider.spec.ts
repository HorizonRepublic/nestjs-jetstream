import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { StreamInfo } from '@nats-io/jetstream';
import { JetStreamApiError } from '@nats-io/jetstream';

import { ConnectionProvider } from '../../connection';
import { StreamKind } from '../../interfaces';
import type { JetstreamModuleOptions } from '../../interfaces';
import { internalName } from '../../jetstream.constants';

import { StreamProvider } from './stream.provider';

describe(StreamProvider, () => {
  let sut: StreamProvider;

  let options: JetstreamModuleOptions;
  let connection: Mocked<ConnectionProvider>;
  let mockJsm: {
    streams: {
      info: ReturnType<typeof vi.fn>;
      add: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    options = { name: faker.lorem.word(), servers: ['nats://localhost:4222'] };

    mockJsm = {
      streams: {
        info: vi.fn(),
        add: vi.fn(),
        update: vi.fn(),
      },
    };

    connection = createMock<ConnectionProvider>({
      getJetStreamManager: vi.fn().mockResolvedValue(mockJsm),
    });

    sut = new StreamProvider(options, connection);
  });

  afterEach(vi.resetAllMocks);

  // ---------------------------------------------------------------------------
  // getStreamName
  // ---------------------------------------------------------------------------

  describe('getStreamName', () => {
    describe('when kind is Event', () => {
      it('should return the correct stream name', () => {
        // When
        const result = sut.getStreamName(StreamKind.Event);

        // Then
        expect(result).toBe(`${options.name}__microservice_ev-stream`);
      });
    });

    describe('when kind is Broadcast', () => {
      it('should return broadcast-stream', () => {
        // When
        const result = sut.getStreamName(StreamKind.Broadcast);

        // Then
        expect(result).toBe('broadcast-stream');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getSubjects — Event
  // ---------------------------------------------------------------------------

  describe('getSubjects', () => {
    describe('when kind is Event without allow_msg_schedules', () => {
      it('should return only the event subject', () => {
        // Given: no stream overrides
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Event);

        // Then
        expect(subjects).toEqual([`${name}.ev.>`]);
      });
    });

    describe('when kind is Event with allow_msg_schedules: true', () => {
      it('should include the _sch namespace', () => {
        // Given: scheduling enabled via stream override
        options.events = { stream: { allow_msg_schedules: true } };
        sut = new StreamProvider(options, connection);
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Event);

        // Then
        expect(subjects).toEqual([`${name}.ev.>`, `${name}._sch.>`]);
      });
    });

    describe('when kind is Event with allow_msg_schedules: false in overrides', () => {
      it('should NOT include the _sch namespace', () => {
        // Given: scheduling explicitly disabled
        options.events = { stream: { allow_msg_schedules: false } };
        sut = new StreamProvider(options, connection);
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Event);

        // Then
        expect(subjects).toEqual([`${name}.ev.>`]);
        expect(subjects).not.toContain(`${name}._sch.>`);
      });
    });

    describe('when kind is Broadcast without allow_msg_schedules', () => {
      it('should return only broadcast.>', () => {
        // When
        const subjects = sut.getSubjects(StreamKind.Broadcast);

        // Then
        expect(subjects).toEqual(['broadcast.>']);
      });
    });

    describe('when kind is Broadcast with allow_msg_schedules: true', () => {
      it('should include broadcast._sch.>', () => {
        // Given: scheduling enabled for broadcast
        options.broadcast = { stream: { allow_msg_schedules: true } };
        sut = new StreamProvider(options, connection);

        // When
        const subjects = sut.getSubjects(StreamKind.Broadcast);

        // Then
        expect(subjects).toEqual(['broadcast.>', 'broadcast._sch.>']);
      });
    });

    describe('when kind is Command', () => {
      it('should return only the command subject', () => {
        // Given
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Command);

        // Then
        expect(subjects).toEqual([`${name}.cmd.>`]);
      });
    });

    describe('when kind is Ordered', () => {
      it('should return only the ordered subject', () => {
        // Given
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Ordered);

        // Then
        expect(subjects).toEqual([`${name}.ordered.>`]);
      });

      it('should never include _sch even when broadcast has allow_msg_schedules enabled', () => {
        // Given: broadcast scheduling is enabled but Ordered should be unaffected
        options.broadcast = { stream: { allow_msg_schedules: true } };
        sut = new StreamProvider(options, connection);
        const name = internalName(options.name);

        // When
        const subjects = sut.getSubjects(StreamKind.Ordered);

        // Then
        expect(subjects).toEqual([`${name}.ordered.>`]);
        expect(subjects.some((s) => s.includes('_sch'))).toBe(false);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // ensureStreams
  // ---------------------------------------------------------------------------

  describe('ensureStreams', () => {
    describe('when the stream does not exist', () => {
      it('should create the stream', async () => {
        // Given: streams.info throws STREAM_NOT_FOUND
        const notFoundError = new JetStreamApiError({
          err_code: 10059,
          code: 404,
          description: 'stream not found',
        });

        mockJsm.streams.info.mockRejectedValue(notFoundError);

        const created = createMock<StreamInfo>();

        mockJsm.streams.add.mockResolvedValue(created);

        // When
        await sut.ensureStreams([StreamKind.Event]);

        // Then
        expect(mockJsm.streams.add).toHaveBeenCalledOnce();
        expect(mockJsm.streams.update).not.toHaveBeenCalled();
      });
    });

    describe('when the stream already exists', () => {
      it('should update the stream config', async () => {
        // Given: streams.info resolves (stream exists)
        mockJsm.streams.info.mockResolvedValue(createMock<StreamInfo>());

        const updated = createMock<StreamInfo>();

        mockJsm.streams.update.mockResolvedValue(updated);

        // When
        await sut.ensureStreams([StreamKind.Event]);

        // Then
        expect(mockJsm.streams.update).toHaveBeenCalledOnce();
        expect(mockJsm.streams.add).not.toHaveBeenCalled();
      });
    });

    describe('when streams.info throws a non-STREAM_NOT_FOUND error', () => {
      it('should rethrow the error', async () => {
        // Given: jsm.streams.info throws an unexpected error
        const authError = new JetStreamApiError({
          err_code: 10100,
          code: 403,
          description: 'authorization violation',
        });

        mockJsm.streams.info.mockRejectedValue(authError);

        // When / Then
        await expect(sut.ensureStreams([StreamKind.Event])).rejects.toThrow(
          'authorization violation',
        );
        expect(mockJsm.streams.add).not.toHaveBeenCalled();
        expect(mockJsm.streams.update).not.toHaveBeenCalled();
      });
    });
  });
});
