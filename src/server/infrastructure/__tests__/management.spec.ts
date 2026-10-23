import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManagementMode, StreamKind } from '../../../interfaces';
import type { JetstreamModuleOptions } from '../../../interfaces';
import { resolveManagementMode } from '../management';

const base: JetstreamModuleOptions = { name: 'svc', servers: ['nats://localhost:4222'] };

describe('resolveManagementMode', () => {
  afterEach(vi.resetAllMocks);
  it('should default to Auto when nothing is set', () => {
    expect(resolveManagementMode(base, StreamKind.Event, 'stream')).toBe(ManagementMode.Auto);
    expect(resolveManagementMode(base, 'dlq', 'stream')).toBe(ManagementMode.Auto);
  });

  it('should apply the global provisioning.management to every entity', () => {
    const options = { ...base, provisioning: { management: ManagementMode.Manual } };

    expect(resolveManagementMode(options, StreamKind.Event, 'stream')).toBe(ManagementMode.Manual);
    expect(resolveManagementMode(options, StreamKind.Broadcast, 'consumer')).toBe(
      ManagementMode.Manual,
    );
    expect(resolveManagementMode(options, 'dlq', 'stream')).toBe(ManagementMode.Manual);
  });

  it('should let per-entity overrides win over the global default', () => {
    const options: JetstreamModuleOptions = {
      ...base,
      provisioning: { management: ManagementMode.Manual },
      events: { management: { consumer: ManagementMode.Auto } },
    };

    expect(resolveManagementMode(options, StreamKind.Event, 'stream')).toBe(ManagementMode.Manual);
    expect(resolveManagementMode(options, StreamKind.Event, 'consumer')).toBe(ManagementMode.Auto);
  });

  it('should read dlq overrides from the dlq block', () => {
    const options: JetstreamModuleOptions = {
      ...base,
      provisioning: { management: ManagementMode.Manual },
      dlq: { management: ManagementMode.Auto },
    };

    expect(resolveManagementMode(options, 'dlq', 'stream')).toBe(ManagementMode.Auto);
  });

  it('should read the ordered override as a bare mode', () => {
    // Given a kind whose consumer is ephemeral, so only the stream has a decision
    const options: JetstreamModuleOptions = {
      ...base,
      provisioning: { management: ManagementMode.Manual },
      ordered: { management: ManagementMode.Auto },
    };

    // When the stream slot is resolved
    // Then the bare mode answers for it
    expect(resolveManagementMode(options, StreamKind.Ordered, 'stream')).toBe(ManagementMode.Auto);
  });

  it('should still read the pre-3.0 object form on dlq and ordered', () => {
    // Given a JavaScript caller passing the shape 2.x accepted
    const options = {
      ...base,
      provisioning: { management: ManagementMode.Manual },
      dlq: { management: { stream: ManagementMode.Auto } },
    } as unknown as JetstreamModuleOptions;

    // When the stream slot is resolved
    // Then the old shape keeps working, so only the types changed
    expect(resolveManagementMode(options, 'dlq', 'stream')).toBe(ManagementMode.Auto);
  });

  it('should read rpc overrides only in jetstream mode', () => {
    const options: JetstreamModuleOptions = {
      ...base,
      rpc: { mode: 'jetstream', management: { stream: ManagementMode.Manual } },
    };

    expect(resolveManagementMode(options, StreamKind.Command, 'stream')).toBe(
      ManagementMode.Manual,
    );
  });

  it('should resolve core mode rpc to Auto for Command', () => {
    expect(
      resolveManagementMode({ ...base, rpc: { mode: 'core' } }, StreamKind.Command, 'stream'),
    ).toBe(ManagementMode.Auto);
  });
});
