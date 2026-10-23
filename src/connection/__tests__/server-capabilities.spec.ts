import type { JetStreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JetstreamCapabilityError, ServerCapabilities } from '../server-capabilities';
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

  // Levels measured on real servers: 2.10 none, 2.11.0 account 1, 2.12.0 2, 2.14.0 4.
  it.each([
    [NatsCapability.MessageTtl, 1, 0],
    [NatsCapability.MessageSchedules, 2, 1],
    [NatsCapability.RecurringSchedules, 4, 3],
  ])('should require level %#: %s from %i', async (capability, required, below) => {
    expect((await probe(required, required)).supports(capability)).toBe(true);
    expect((await probe(below, below)).supports(capability)).toBe(false);
  });

  it('should carry the capability and both levels on the error', async () => {
    // Given
    const sut = await probe(undefined, 1);

    // When / Then
    expect(() => {
      sut.assert(NatsCapability.MessageSchedules, 'scheduleAt()');
    }).toThrow(
      expect.objectContaining({
        capability: NatsCapability.MessageSchedules,
        requiredLevel: 2,
        actualLevel: 1,
      }),
    );
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
    expect(act).toThrow(JetstreamCapabilityError);
    expect(act).toThrow(
      'Handler "sync.tick" needs NATS JetStream API level 4 (NATS 2.14 or newer); ' +
        'n1 (NATS 2.12.6) reports level 3.',
    );
  });
});
