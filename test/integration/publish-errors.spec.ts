import { INestApplication } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { TestingModule } from '@nestjs/testing';

import { DiscardPolicy, JetStreamApiError, jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { firstValueFrom } from 'rxjs';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getClientToken,
  internalName,
  JetstreamPublishError,
  NatsErrorCode,
  PublishErrorReason,
} from '../../src';
import {
  createNatsConnection,
  createTestApp,
  deleteStreamIfExists,
  uniqueServiceName,
} from './helpers';
import { startNatsContainer } from './nats-container';

describe('Publish errors', () => {
  let nc: NatsConnection;
  let container: StartedTestContainer;
  let port: number;

  beforeAll(async () => {
    ({ container, port } = await startNatsContainer());
    nc = await createNatsConnection(port);
  });

  afterAll(async () => {
    try {
      await nc.drain();
    } finally {
      await container.stop();
    }
  });

  describe('when the target stream is full and discards new messages', () => {
    let app: INestApplication;
    let module: TestingModule;
    let client: ClientProxy;
    let target: string;
    let stream: string;

    beforeEach(async () => {
      target = uniqueServiceName();
      stream = `${target}-full`;

      const jsm = await jetstreamManager(nc);

      await jsm.streams.add({
        name: stream,
        subjects: [`${internalName(target)}.ev.>`],
        discard: DiscardPolicy.New,
        max_msgs: 1,
      });

      ({ app, module } = await createTestApp({ name: uniqueServiceName(), port }, [], [target]));
      client = module.get<ClientProxy>(getClientToken(target));
    });

    afterEach(async () => {
      await app.close();
      await deleteStreamIfExists(await jetstreamManager(nc), stream);
    });

    it('should reject the publish with JetstreamPublishError that is still a JetStreamApiError', async () => {
      // Given: the only slot is taken
      await firstValueFrom(client.emit('order.placed', { id: 1 }));

      // When
      const failure = await firstValueFrom(client.emit('order.placed', { id: 2 })).catch(
        (err: unknown) => err,
      );

      // Then
      expect(failure).toBeInstanceOf(JetstreamPublishError);
      expect(failure).toBeInstanceOf(JetStreamApiError);
      expect(failure).toMatchObject({
        reason: PublishErrorReason.StreamFull,
        code: NatsErrorCode.StreamStoreFailed,
        message: 'maximum messages exceeded',
        cause: expect.any(JetStreamApiError),
      });
    });
  });
});
