import { connect } from 'nats';

describe('NATS connectivity', () => {
  it('should connect to local NATS server', async () => {
    const nc = await connect({ servers: ['nats://localhost:4222'] });

    expect(nc.getServer()).toContain('localhost');
    await nc.drain();
  });

  it('should have JetStream enabled', async () => {
    const nc = await connect({ servers: ['nats://localhost:4222'] });
    const jsm = await nc.jetstreamManager();
    const info = await jsm.getAccountInfo();

    expect(info).toBeDefined();
    await nc.drain();
  });
});
