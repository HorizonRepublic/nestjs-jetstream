import type { Logger } from '@nestjs/common';

import type { ConsumerInfo, JetStreamManager } from '@nats-io/jetstream';

import { isNatsError, NatsErrorCode } from './nats-error-codes';
import type { MigrationTiming } from './stream-migration.types';

/** JetStream API level that introduced consumer pause (NATS 2.11). */
const PAUSE_API_LEVEL = 1;
const IDLE_POLL_INTERVAL_MS = 100;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isGone = (err: unknown): boolean =>
  isNatsError(err, NatsErrorCode.ConsumerNotFound) ||
  isNatsError(err, NatsErrorCode.StreamNotFound);

/**
 * Pauses the durable consumers of a stream while a migration copies it, so
 * replicas still running the old release stop taking messages out of it.
 *
 * Each pause ends on its own one abandonment window after the last renewal,
 * so a migrating instance that dies never leaves a consumer paused for long.
 */
export class MigrationConsumerPause {
  private names: string[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(
    private readonly jsm: JetStreamManager,
    private readonly streamName: string,
    private readonly timing: MigrationTiming,
    private readonly logger: Logger,
  ) {}

  /** Resume consumers an earlier migration recorded as paused; gone ones are skipped. */
  public static async resumeAll(
    jsm: JetStreamManager,
    streamName: string,
    names: readonly string[],
    logger: Logger,
  ): Promise<void> {
    await Promise.all(
      names.map(async (name) => {
        try {
          await jsm.consumers.resume(streamName, name);
        } catch (err) {
          if (!isGone(err)) {
            logger.warn(
              `Could not resume consumer ${name} on ${streamName}; it resumes on its own`,
              err,
            );
          }
        }
      }),
    );
  }

  /** Durable consumers of the stream nobody else paused, to be paused by {@link pause}. */
  public async listDurables(): Promise<string[]> {
    if (!(await this.supported())) {
      this.logger.warn(
        `Stream ${this.streamName}: this NATS server cannot pause consumers (needs 2.11 or ` +
          'newer); replicas that keep consuming during the migration may process messages twice',
      );

      return [];
    }

    const names: string[] = [];

    for await (const info of this.jsm.consumers.list(this.streamName)) {
      if (this.isPausable(info)) names.push(info.name);
    }

    return names;
  }

  /**
   * Pause the consumers and keep renewing the pause while `isHeld` says the
   * migration lock is still this instance's.
   */
  public async pause(names: readonly string[], isHeld: () => boolean): Promise<void> {
    this.names = [...names];

    if (this.names.length === 0) return;

    await this.renew();
    this.logger.log(`Stream ${this.streamName}: paused consumers ${this.names.join(', ')}`);
    this.timer = setInterval(() => {
      if (!isHeld()) {
        this.stop();

        return;
      }

      this.renew().catch((err: unknown) => {
        this.logger.debug(`Renewing the consumer pause on ${this.streamName} failed`, err);
      });
    }, this.timing.heartbeatIntervalMs);
    this.timer.unref();
  }

  /**
   * Wait until no message the paused consumers delivered is still unacknowledged,
   * so none is copied and then processed. Gives up after the stall timeout.
   */
  public async waitIdle(assertHeld: () => void): Promise<void> {
    const deadline = Date.now() + this.timing.stallTimeoutMs;

    while (this.names.length > 0) {
      assertHeld();

      const pending = await this.pendingAcks();

      if (pending === 0) return;

      if (Date.now() >= deadline) {
        this.logger.warn(
          `Stream ${this.streamName}: ${pending} delivered messages are still unacknowledged ` +
            `after ${this.timing.stallTimeoutMs / 1000}s; migrating anyway, so they may be ` +
            'processed again after the restore',
        );

        return;
      }

      await sleep(IDLE_POLL_INTERVAL_MS);
    }
  }

  /** Stop renewing and resume every consumer this instance paused. */
  public async resume(): Promise<void> {
    this.stop();
    await MigrationConsumerPause.resumeAll(this.jsm, this.streamName, this.names, this.logger);
  }

  /** Stop renewing; the pauses run out on their own. */
  public stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async renew(): Promise<void> {
    const until = new Date(Date.now() + this.timing.abandonedAfterMs);

    await Promise.all(
      this.names.map(async (name) => {
        try {
          await this.jsm.consumers.pause(this.streamName, name, until);
        } catch (err) {
          if (!isGone(err)) throw err;
        }
      }),
    );
  }

  private async pendingAcks(): Promise<number> {
    const counts = await Promise.all(
      this.names.map(async (name) => {
        try {
          return (await this.jsm.consumers.info(this.streamName, name)).num_ack_pending;
        } catch (err) {
          if (isGone(err)) return 0;

          throw err;
        }
      }),
    );

    return counts.reduce((sum, count) => sum + count, 0);
  }

  private isPausable(info: ConsumerInfo): boolean {
    return info.config.durable_name !== undefined && info.paused !== true;
  }

  private async supported(): Promise<boolean> {
    const { api } = await this.jsm.getAccountInfo();

    return (api.level ?? 0) >= PAUSE_API_LEVEL;
  }
}
