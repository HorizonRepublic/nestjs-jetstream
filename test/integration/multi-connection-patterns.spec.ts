import { Controller } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import type { ClientProxy } from '@nestjs/microservices';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getClientToken, JetstreamConnection } from '../../src';
import type { Codec } from '../../src';
import { createMultiConnectionApp, uniqueServiceName, waitForCondition } from './helpers';
import { startNatsContainer } from './nats-container';

const received: string[] = [];

/** Default connection: events, RPC, broadcast and ordered all unqualified. */
@Controller()
class PrimaryController {
  @EventPattern('work.done')
  public onWork(@Payload() data: { id: string }): void {
    received.push(`primary-event:${data.id}`);
  }

  @MessagePattern('ping')
  public ping(@Payload() data: { id: string }): string {
    return `primary-pong:${data.id}`;
  }

  @EventPattern('config.changed', { broadcast: true })
  public onBroadcast(@Payload() data: { id: string }): void {
    received.push(`primary-broadcast:${data.id}`);
  }

  @EventPattern('step.taken', { ordered: true })
  public onOrdered(@Payload() data: { seq: number }): void {
    received.push(`primary-ordered:${data.seq}`);
  }
}

/** Every pattern on this controller lives on the analytics cluster instead. */
@JetstreamConnection('analytics')
@Controller()
class AnalyticsController {
  @EventPattern('work.done')
  public onWork(@Payload() data: { id: string }): void {
    received.push(`analytics-event:${data.id}`);
  }

  @MessagePattern('ping')
  public ping(@Payload() data: { id: string }): string {
    return `analytics-pong:${data.id}`;
  }

  @EventPattern('config.changed', { broadcast: true })
  public onBroadcast(@Payload() data: { id: string }): void {
    received.push(`analytics-broadcast:${data.id}`);
  }

  @EventPattern('step.taken', { ordered: true })
  public onOrdered(@Payload() data: { seq: number }): void {
    received.push(`analytics-ordered:${data.seq}`);
  }
}

describe('delivery patterns on named connections', () => {
  let primaryContainer: StartedTestContainer;
  let analyticsContainer: StartedTestContainer;
  let primaryPort: number;
  let analyticsPort: number;
  let app: INestApplication;
  let serviceName: string;

  const primaryClient = (): ClientProxy => app.get<ClientProxy>(getClientToken(serviceName));
  const analyticsClient = (): ClientProxy =>
    app.get<ClientProxy>(getClientToken(serviceName, 'analytics'));

  beforeAll(async () => {
    const [primary, analytics] = await Promise.all([startNatsContainer(), startNatsContainer()]);

    primaryContainer = primary.container;
    primaryPort = primary.port;
    analyticsContainer = analytics.container;
    analyticsPort = analytics.port;

    serviceName = uniqueServiceName();

    ({ app } = await createMultiConnectionApp({
      name: serviceName,
      connections: {
        primary: { servers: [`nats://localhost:${primaryPort}`] },
        analytics: { servers: [`nats://localhost:${analyticsPort}`] },
      },
      defaultConnection: 'primary',
      controllers: [PrimaryController, AnalyticsController],
      clients: [{ name: serviceName }, { name: serviceName, connection: 'analytics' }],
    }));
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([primaryContainer.stop(), analyticsContainer.stop()]);
  });

  afterEach(() => {
    received.length = 0;
  });

  it('should route the same event pattern to the connection it was published on', async () => {
    // Given the identical pattern registered on both connections — the
    // cluster-migration scenario
    // When it is published on each connection in turn
    await firstValueFrom(primaryClient().emit('work.done', { id: 'p' }));
    await firstValueFrom(analyticsClient().emit('work.done', { id: 'a' }));

    // Then each handler sees only its own cluster's message
    await waitForCondition(
      () => received.includes('primary-event:p') && received.includes('analytics-event:a'),
      15_000,
    );

    expect(received).toContain('primary-event:p');
    expect(received).toContain('analytics-event:a');
    expect(received).not.toContain('primary-event:a');
    expect(received).not.toContain('analytics-event:p');
  });

  it('should answer core RPC on the connection the request was sent to', async () => {
    // Given the same RPC pattern on both connections
    // When each client sends a request
    const fromPrimary = await firstValueFrom(primaryClient().send('ping', { id: '1' }));
    const fromAnalytics = await firstValueFrom(analyticsClient().send('ping', { id: '2' }));

    // Then the reply comes from the handler bound to that connection
    expect(fromPrimary).toBe('primary-pong:1');
    expect(fromAnalytics).toBe('analytics-pong:2');
  });

  it('should keep broadcast fan-out inside its own cluster', async () => {
    // Given broadcast handlers on both connections
    // When a broadcast is published on analytics only
    await firstValueFrom(analyticsClient().emit('broadcast:config.changed', { id: 'b1' }));

    // Then the primary cluster's broadcast handler stays silent
    await waitForCondition(() => received.includes('analytics-broadcast:b1'), 15_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(received).toContain('analytics-broadcast:b1');
    expect(received).not.toContain('primary-broadcast:b1');
  });

  it('should deliver ordered events per connection, in sequence', async () => {
    // Given ordered handlers on both connections
    // When three ordered events are published on analytics
    for (const seq of [1, 2, 3]) {
      await firstValueFrom(analyticsClient().emit('ordered:step.taken', { seq }));
    }

    // Then they arrive in order, and only on that connection
    await waitForCondition(
      () => received.filter((r) => r.startsWith('analytics-ordered:')).length === 3,
      15_000,
    );

    expect(received.filter((r) => r.startsWith('analytics-ordered:'))).toEqual([
      'analytics-ordered:1',
      'analytics-ordered:2',
      'analytics-ordered:3',
    ]);
    expect(received.some((r) => r.startsWith('primary-ordered:'))).toBe(false);
  });
});

const codecReceived: unknown[] = [];

/**
 * A codec that stamps what encoded the payload, so a decode proves which
 * connection's codec ran rather than merely that JSON round-tripped.
 */
class TaggedCodec implements Codec {
  public constructor(private readonly tag: string) {}

  public encode(data: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ tag: this.tag, data }));
  }

  public decode(data: Uint8Array): unknown {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as { tag: string; data: unknown };

    return { ...(parsed.data as Record<string, unknown>), decodedBy: parsed.tag };
  }
}

@Controller()
class PlainController {
  @EventPattern('codec.check')
  public onPlain(@Payload() data: unknown): void {
    codecReceived.push(data);
  }
}

@JetstreamConnection('packed')
@Controller()
class PackedController {
  @EventPattern('codec.check')
  public onPacked(@Payload() data: unknown): void {
    codecReceived.push(data);
  }
}

describe('per-connection codec and publisher-only connections', () => {
  let plainContainer: StartedTestContainer;
  let packedContainer: StartedTestContainer;
  let plainPort: number;
  let packedPort: number;
  let app: INestApplication | undefined;

  beforeAll(async () => {
    const [plain, packed] = await Promise.all([startNatsContainer(), startNatsContainer()]);

    plainContainer = plain.container;
    plainPort = plain.port;
    packedContainer = packed.container;
    packedPort = packed.port;
  });

  afterAll(async () => {
    await Promise.all([plainContainer.stop(), packedContainer.stop()]);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    codecReceived.length = 0;
  });

  it('should honour a codec declared on one connection only', async () => {
    // Given msgpack on the second connection and the default JSON on the first
    const serviceName = uniqueServiceName();

    ({ app } = await createMultiConnectionApp({
      name: serviceName,
      connections: {
        plain: { servers: [`nats://localhost:${plainPort}`] },
        packed: { servers: [`nats://localhost:${packedPort}`], codec: new TaggedCodec('packed') },
      },
      defaultConnection: 'plain',
      controllers: [PlainController, PackedController],
      clients: [{ name: serviceName }, { name: serviceName, connection: 'packed' }],
    }));

    // When each connection round-trips a payload through its own codec
    await firstValueFrom(
      app.get<ClientProxy>(getClientToken(serviceName)).emit('codec.check', { via: 'plain' }),
    );
    await firstValueFrom(
      app
        .get<ClientProxy>(getClientToken(serviceName, 'packed'))
        .emit('codec.check', { via: 'tagged' }),
    );

    // Then the default connection used the root JSON codec, and the named one
    // decoded through its own — the tag proves which codec actually ran
    await waitForCondition(() => codecReceived.length === 2, 15_000);
    expect(codecReceived).toContainEqual({ via: 'plain' });
    expect(codecReceived).toContainEqual({ via: 'tagged', decodedBy: 'packed' });
  });

  it('should let one connection be publisher-only while another consumes', async () => {
    // Given a consumer connection and a publish-only one
    const serviceName = uniqueServiceName();

    ({ app } = await createMultiConnectionApp({
      name: serviceName,
      connections: {
        plain: { servers: [`nats://localhost:${plainPort}`] },
        packed: { servers: [`nats://localhost:${packedPort}`], consumer: false },
      },
      defaultConnection: 'plain',
      controllers: [PlainController],
      clients: [{ name: serviceName }, { name: serviceName, connection: 'packed' }],
    }));

    // When the consuming connection receives an event
    await firstValueFrom(
      app.get<ClientProxy>(getClientToken(serviceName)).emit('codec.check', { via: 'consumer' }),
    );

    // Then it is handled, and the publisher-only connection still exposes a client
    await waitForCondition(() => codecReceived.length === 1, 15_000);
    expect(codecReceived).toContainEqual({ via: 'consumer' });
    expect(app.get<ClientProxy>(getClientToken(serviceName, 'packed'))).toBeDefined();
  });
});
