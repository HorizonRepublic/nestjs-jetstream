import { describe, expect, it } from 'vitest';

import { DEFAULT_TRACES, JetstreamTrace } from '../trace-kinds';

describe('JetstreamTrace', () => {
  it('should expose stable string identifiers for each trace kind', () => {
    // When + Then
    expect(JetstreamTrace.Publish).toBe('publish');
    expect(JetstreamTrace.Consume).toBe('consume');
    expect(JetstreamTrace.RpcClientSend).toBe('rpc.client.send');
    expect(JetstreamTrace.DeadLetter).toBe('dead_letter');
    expect(JetstreamTrace.ConnectionLifecycle).toBe('connection.lifecycle');
    expect(JetstreamTrace.SelfHealing).toBe('self_healing');
    expect(JetstreamTrace.Provisioning).toBe('provisioning');
    expect(JetstreamTrace.Migration).toBe('migration');
    expect(JetstreamTrace.Shutdown).toBe('shutdown');
  });
});

describe('DEFAULT_TRACES', () => {
  it('should enable the four functional trace kinds out of the box', () => {
    // When + Then
    expect([...DEFAULT_TRACES]).toEqual([
      JetstreamTrace.Publish,
      JetstreamTrace.Consume,
      JetstreamTrace.RpcClientSend,
      JetstreamTrace.DeadLetter,
    ]);
  });

  it('should not include any infrastructure trace kinds by default', () => {
    // When + Then
    expect(DEFAULT_TRACES).not.toContain(JetstreamTrace.ConnectionLifecycle);
    expect(DEFAULT_TRACES).not.toContain(JetstreamTrace.SelfHealing);
    expect(DEFAULT_TRACES).not.toContain(JetstreamTrace.Provisioning);
    expect(DEFAULT_TRACES).not.toContain(JetstreamTrace.Migration);
    expect(DEFAULT_TRACES).not.toContain(JetstreamTrace.Shutdown);
  });
});
