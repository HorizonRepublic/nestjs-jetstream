import type { JetStreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JetstreamScheduleError } from '../../schedule';
import { ServerCapabilities } from '../server-capabilities';
import { NatsCapability } from '../server-capabilities.types';

const probe = async (
  apiLvl: number | undefined,
  accountLevel: number | undefined,
): Promise<ServerCapabilities> => {
  const nc = createMock<NatsConnection>({
    info: { server_name: 'n1', version: '2.12.6', api_lvl: apiLvl },
  });
  const jsm = createMock<JetStreamManager>({
    getAccountInfo: vi.fn().mockResolvedValue({ api: { level: accountLevel } }),
  });

  return ServerCapabilities.probe(nc, jsm);
};

describe(ServerCapabilities, () => {
  afterEach(vi.resetAllMocks);

  it('should take the lower of the server and account levels', async () => {
    expect((await probe(5, 4)).apiLevel).toBe(4);
    expect((await probe(3, 4)).apiLevel).toBe(3);
  });

  it('should fall back to the account level when the server reports none', async () => {
    expect((await probe(undefined, 1)).apiLevel).toBe(1);
  });

  it('should count a server that reports no level as level 0', async () => {
    expect((await probe(undefined, undefined)).apiLevel).toBe(0);
  });

  it('should support recurring schedules from level 4', async () => {
    expect((await probe(4, 4)).supports(NatsCapability.RecurringSchedules)).toBe(true);
    expect((await probe(5, 5)).supports(NatsCapability.RecurringSchedules)).toBe(true);
    expect((await probe(3, 3)).supports(NatsCapability.RecurringSchedules)).toBe(false);
  });

  it('should pass the assertion on a server that supports the capability', async () => {
    const sut = await probe(4, 4);

    expect(() => {
      sut.assert(NatsCapability.RecurringSchedules, 'Handler "sync.tick"');
    }).not.toThrow();
  });

  it('should name the usage, the requirement and the server when the assertion fails', async () => {
    // Given
    const sut = await probe(3, 3);

    // When
    const act = (): void => {
      sut.assert(NatsCapability.RecurringSchedules, 'Handler "sync.tick"');
    };

    // Then
    expect(act).toThrow(JetstreamScheduleError);
    expect(act).toThrow(
      'Handler "sync.tick" needs NATS JetStream API level 4 (NATS 2.14 or newer); ' +
        'n1 (NATS 2.12.6) reports level 3.',
    );
  });
});
