import { describe, expect, it } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import { HttpException, NotFoundException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import type { JsMsg } from '@nats-io/jetstream';

import {
  buildConsumeAttributes,
  buildDeadLetterAttributes,
  buildExpectedErrorAttributes,
  buildPublishAttributes,
  buildRpcClientAttributes,
} from '../attributes';
import { ConsumeKind, PublishKind } from '../config';

const baseCtx = (): {
  subject: string;
  serviceName: string;
  serverAddress: string;
  serverPort: number;
} => ({
  subject: `orders.${faker.string.uuid()}`,
  serviceName: faker.word.noun(),
  serverAddress: faker.internet.ip(),
  serverPort: faker.internet.port(),
});

describe('buildPublishAttributes', () => {
  it('should set the required messaging attributes for an event publish', () => {
    // Given
    const base = baseCtx();
    const payloadBytes = faker.number.int({ min: 1, max: 8_000 });

    // When
    const attrs = buildPublishAttributes({
      ...base,
      kind: PublishKind.Event,
      payloadBytes,
    });

    // Then
    expect(attrs).toMatchObject({
      'messaging.system': 'nats',
      'messaging.destination.name': base.subject,
      'messaging.client.id': base.serviceName,
      'messaging.operation.name': 'publish',
      'messaging.operation.type': 'send',
      'messaging.message.body.size': payloadBytes,
      'jetstream.kind': 'event',
      'server.address': base.serverAddress,
      'server.port': base.serverPort,
    });
  });

  it('should normalize rpc.request kind to "rpc" for the jetstream.kind attribute', () => {
    // When
    const attrs = buildPublishAttributes({
      ...baseCtx(),
      kind: PublishKind.RpcRequest,
      payloadBytes: 1,
    });

    // Then
    expect(attrs['jetstream.kind']).toBe('rpc');
  });

  it('should add destination.template only when pattern differs from subject', () => {
    // Given
    const base = baseCtx();
    const pattern = 'orders.*';

    // When
    const sameAttrs = buildPublishAttributes({
      ...base,
      pattern: base.subject,
      kind: PublishKind.Event,
      payloadBytes: 1,
    });

    const differentAttrs = buildPublishAttributes({
      ...base,
      pattern,
      kind: PublishKind.Event,
      payloadBytes: 1,
    });

    // Then
    expect(sameAttrs['messaging.destination.template']).toBeUndefined();
    expect(differentAttrs['messaging.destination.template']).toBe(pattern);
  });

  it('should attach optional message id and conversation id when provided', () => {
    // Given
    const messageId = faker.string.uuid();
    const correlationId = faker.string.uuid();

    // When
    const attrs = buildPublishAttributes({
      ...baseCtx(),
      kind: PublishKind.RpcRequest,
      payloadBytes: 1,
      messageId,
      correlationId,
    });

    // Then
    expect(attrs['messaging.message.id']).toBe(messageId);
    expect(attrs['messaging.message.conversation_id']).toBe(correlationId);
  });
});

describe('buildConsumeAttributes', () => {
  it('should emit JetStream-specific attributes when info is provided', () => {
    // Given
    const info = {
      stream: 'orders-stream',
      consumer: 'orders-worker',
      streamSequence: faker.number.int({ min: 1, max: 1_000_000 }),
      deliverySequence: faker.number.int({ min: 1, max: 1_000_000 }),
      deliveryCount: faker.number.int({ min: 1, max: 5 }),
    };
    const msg = createMock<JsMsg>({
      headers: undefined,
    });

    // When
    const attrs = buildConsumeAttributes({
      ...baseCtx(),
      msg,
      info: info as never,
      kind: ConsumeKind.Event,
      payloadBytes: 100,
    });

    // Then
    expect(attrs).toMatchObject({
      'messaging.operation.name': 'process',
      'messaging.operation.type': 'process',
      'messaging.nats.stream.name': info.stream,
      'messaging.consumer.group.name': info.consumer,
      'messaging.nats.message.stream_sequence': info.streamSequence,
      'messaging.nats.message.consumer_sequence': info.deliverySequence,
      'messaging.nats.message.delivery_count': info.deliveryCount,
    });
  });

  it('should omit JetStream-specific attributes when info is absent (Core RPC path)', () => {
    // Given
    const msg = createMock<JsMsg>({ headers: undefined });

    // When
    const attrs = buildConsumeAttributes({
      ...baseCtx(),
      msg,
      kind: ConsumeKind.Rpc,
      payloadBytes: 100,
    });

    // Then
    expect(attrs['messaging.nats.stream.name']).toBeUndefined();
    expect(attrs['messaging.consumer.group.name']).toBeUndefined();
    expect(attrs['messaging.nats.message.delivery_count']).toBeUndefined();
  });
});

describe('buildRpcClientAttributes', () => {
  it('should mark the operation as send and tag jetstream.kind as rpc', () => {
    // Given
    const correlationId = faker.string.uuid();

    // When
    const attrs = buildRpcClientAttributes({
      ...baseCtx(),
      correlationId,
      payloadBytes: 100,
    });

    // Then
    expect(attrs).toMatchObject({
      'messaging.operation.name': 'send',
      'messaging.operation.type': 'send',
      'messaging.message.conversation_id': correlationId,
      'jetstream.kind': 'rpc',
    });
  });
});

describe('buildDeadLetterAttributes', () => {
  it('should record the final delivery count and operation name', () => {
    // Given
    const finalDeliveryCount = faker.number.int({ min: 3, max: 10 });

    // When
    const attrs = buildDeadLetterAttributes({
      ...baseCtx(),
      finalDeliveryCount,
    });

    // Then
    expect(attrs).toMatchObject({
      'messaging.operation.name': 'dead_letter',
      'messaging.operation.type': 'process',
      'messaging.nats.message.delivery_count': finalDeliveryCount,
    });
  });

  it('should include reason when provided', () => {
    // Given
    const reason = faker.lorem.sentence();

    // When
    const attrs = buildDeadLetterAttributes({
      ...baseCtx(),
      finalDeliveryCount: 3,
      reason,
    });

    // Then
    expect(attrs['jetstream.dead_letter.reason']).toBe(reason);
  });
});

describe('buildExpectedErrorAttributes', () => {
  it('should always set has_error=true', () => {
    // Given
    const sut = buildExpectedErrorAttributes(new Error('any'));

    // When + Then
    expect(sut['jetstream.rpc.reply.has_error']).toBe(true);
  });

  it('should extract code from RpcException payload object', () => {
    // Given
    const code = 'NOT_AUTHORIZED';
    const err = new RpcException({ code });

    // When
    const sut = buildExpectedErrorAttributes(err);

    // Then
    expect(sut['jetstream.rpc.reply.error.code']).toBe(code);
  });

  it('should extract a stable string-code RpcException payload', () => {
    // Given — stable UPPER_SNAKE_CASE tokens are safe to surface on the span.
    const code = 'ORDER_NOT_FOUND';
    const err = new RpcException(code);

    // When
    const sut = buildExpectedErrorAttributes(err);

    // Then
    expect(sut['jetstream.rpc.reply.error.code']).toBe(code);
  });

  it('should drop free-form RpcException messages to avoid high-cardinality error codes', () => {
    // Given — arbitrary message strings can contain PII / request-scoped data
    // and must not land on the `error.code` attribute.
    const err = new RpcException('User 42 is not authorised for this order');

    // When
    const sut = buildExpectedErrorAttributes(err);

    // Then
    expect(sut['jetstream.rpc.reply.error.code']).toBeUndefined();
    expect(sut['jetstream.rpc.reply.has_error']).toBe(true);
  });

  it('should fall through to err.code when RpcException payload has no stable token', () => {
    // Given
    const err = Object.assign(new RpcException('ignored free-form message'), {
      code: 'DOMAIN_RULE_VIOLATED',
    });

    // When
    const sut = buildExpectedErrorAttributes(err);

    // Then
    expect(sut['jetstream.rpc.reply.error.code']).toBe('DOMAIN_RULE_VIOLATED');
  });

  it('should format HttpException status as HTTP_<status>', () => {
    // Given
    const err = new HttpException('forbidden', 403);

    // When
    const sut = buildExpectedErrorAttributes(err);

    // Then
    expect(sut['jetstream.rpc.reply.error.code']).toBe('HTTP_403');
  });

  it('should walk the prototype chain for HttpException subclasses', () => {
    // Given
    const err = new NotFoundException('missing');

    // When
    const sut = buildExpectedErrorAttributes(err);

    // Then
    expect(sut['jetstream.rpc.reply.error.code']).toBe('HTTP_404');
  });

  it('should fall back to err.code on plain objects', () => {
    // Given
    const err = { code: 'CUSTOM_CODE' };

    // When
    const sut = buildExpectedErrorAttributes(err);

    // Then
    expect(sut['jetstream.rpc.reply.error.code']).toBe('CUSTOM_CODE');
  });

  it('should omit code when none can be derived', () => {
    // When
    const sut = buildExpectedErrorAttributes(new Error('boom'));

    // Then
    expect(sut['jetstream.rpc.reply.error.code']).toBeUndefined();
  });
});
