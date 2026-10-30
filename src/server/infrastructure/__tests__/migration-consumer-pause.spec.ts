import { Logger } from '@nestjs/common';

import { JetStreamApiError, type ConsumerInfo, type JetStreamManager } from '@nats-io/jetstream';

import { faker } from '@faker-js/faker';
import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MigrationConsumerPause } from '../migration-consumer-pause';
import type { MigrationTiming } from '../stream-migration.types';

const TIMING: MigrationTiming = {
  heartbeatIntervalMs: 100,
  abandonedAfterMs: 600,
  stallTimeoutMs: 300,
};

type AccountInfo = Awaited<ReturnType<JetStreamManager['getAccountInfo']>>;

const consumerNotFound = (): JetStreamApiError =>
  new JetStreamApiError({ err_code: 10014, code: 404, description: 'consumer not found' });

const listOf = (infos: ConsumerInfo[]): AsyncIterable<ConsumerInfo> => ({
  async *[Symbol.asyncIterator]() {
    yield* infos;
  },
});

describe(MigrationConsumerPause, () => {
  let jsm: JetStreamManager;
  let logger: Logger;
  let stream: string;

  beforeEach(() => {
    stream = faker.lorem.word();
    logger = createMock<Logger>();
    jsm = createMock<JetStreamManager>({
      getAccountInfo: vi.fn().mockResolvedValue({ api: { level: 2 } }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe('listDurables', () => {
    it('should list durable consumers nobody paused', async () => {
      // Given
      vi.mocked(jsm.consumers.list).mockReturnValue(
        listOf([
          createMock<ConsumerInfo>({ name: 'a', config: { durable_name: 'a' }, paused: false }),
          createMock<ConsumerInfo>({ name: 'b', config: { durable_name: 'b' }, paused: true }),
          createMock<ConsumerInfo>({ name: 'eph', config: { durable_name: undefined } }),
        ]) as never,
      );

      const sut = new MigrationConsumerPause(jsm, stream, TIMING, logger);

      // When
      const names = await sut.listDurables();

      // Then
      expect(names).toEqual(['a']);
    });

    it('should pause nothing on a server without consumer pause', async () => {
      // Given: NATS 2.10 reports no API level
      vi.mocked(jsm.getAccountInfo).mockResolvedValue(
        createMock<AccountInfo>({ api: { level: undefined } }),
      );

      const sut = new MigrationConsumerPause(jsm, stream, TIMING, logger);

      // When
      const names = await sut.listDurables();

      // Then
      expect(names).toEqual([]);
      expect(jsm.consumers.list).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cannot pause consumers'));
    });
  });

  describe('pause', () => {
    it('should renew the pause while the lock is held, then stop', async () => {
      // Given
      vi.useFakeTimers();

      let held = true;
      const sut = new MigrationConsumerPause(jsm, stream, TIMING, logger);

      await sut.pause(['a'], () => held);

      // When
      await vi.advanceTimersByTimeAsync(TIMING.heartbeatIntervalMs * 2);
      held = false;
      await vi.advanceTimersByTimeAsync(TIMING.heartbeatIntervalMs * 3);

      // Then: the first pause and two renewals, nothing after the lock went
      expect(jsm.consumers.pause).toHaveBeenCalledTimes(3);
    });

    it('should skip a consumer that is already gone', async () => {
      // Given
      vi.mocked(jsm.consumers.pause).mockRejectedValue(consumerNotFound());

      const sut = new MigrationConsumerPause(jsm, stream, TIMING, logger);

      // When / Then
      await expect(sut.pause(['a'], () => true)).resolves.toBeUndefined();
      sut.stop();
    });
  });

  describe('waitIdle', () => {
    it('should return once no delivered message is pending', async () => {
      // Given
      vi.mocked(jsm.consumers.info)
        .mockResolvedValueOnce(createMock<ConsumerInfo>({ num_ack_pending: 2 }))
        .mockResolvedValue(createMock<ConsumerInfo>({ num_ack_pending: 0 }));

      const sut = new MigrationConsumerPause(jsm, stream, TIMING, logger);

      await sut.pause(['a'], () => true);

      // When
      await sut.waitIdle(() => undefined);

      // Then
      expect(jsm.consumers.info).toHaveBeenCalledTimes(2);
      expect(logger.warn).not.toHaveBeenCalled();
      sut.stop();
    });

    it('should give up with a warning once the stall timeout passes', async () => {
      // Given
      vi.mocked(jsm.consumers.info).mockResolvedValue(
        createMock<ConsumerInfo>({ num_ack_pending: 1 }),
      );

      const sut = new MigrationConsumerPause(jsm, stream, TIMING, logger);

      await sut.pause(['a'], () => true);

      // When
      await sut.waitIdle(() => undefined);

      // Then
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('still unacknowledged'));
      sut.stop();
    });

    it('should count a consumer that vanished as idle', async () => {
      // Given
      vi.mocked(jsm.consumers.info).mockRejectedValue(consumerNotFound());

      const sut = new MigrationConsumerPause(jsm, stream, TIMING, logger);

      await sut.pause(['a'], () => true);

      // When / Then
      await expect(sut.waitIdle(() => undefined)).resolves.toBeUndefined();
      sut.stop();
    });

    it('should stop when the lock is lost', async () => {
      // Given
      const lost = new Error('lock lost');
      const sut = new MigrationConsumerPause(jsm, stream, TIMING, logger);

      await sut.pause(['a'], () => true);

      // When / Then
      await expect(
        sut.waitIdle(() => {
          throw lost;
        }),
      ).rejects.toBe(lost);
      sut.stop();
    });
  });

  describe('resumeAll', () => {
    it('should resume every named consumer', async () => {
      // When
      await MigrationConsumerPause.resumeAll(jsm, stream, ['a', 'b'], logger);

      // Then
      expect(jsm.consumers.resume).toHaveBeenCalledWith(stream, 'a');
      expect(jsm.consumers.resume).toHaveBeenCalledWith(stream, 'b');
    });

    it('should skip gone consumers quietly and warn about other failures', async () => {
      // Given
      vi.mocked(jsm.consumers.resume)
        .mockRejectedValueOnce(consumerNotFound())
        .mockRejectedValueOnce(new Error('timeout'));

      // When
      await MigrationConsumerPause.resumeAll(jsm, stream, ['gone', 'slow'], logger);

      // Then
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('slow'), expect.any(Error));
    });
  });
});
