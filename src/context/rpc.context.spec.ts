import { createMock } from '@golevelup/ts-jest';
import { faker } from '@faker-js/faker';
import type { JsMsg, Msg, MsgHdrs } from 'nats';

import { RpcContext } from './rpc.context';

describe(RpcContext, () => {
  describe('happy path', () => {
    describe('when created with a Core Msg', () => {
      it('should return the message via getMessage()', () => {
        // Given: a core NATS message
        const msg = createMock<Msg>({ subject: faker.lorem.word() });
        const sut = new RpcContext([msg]);

        // Then: message is accessible
        expect(sut.getMessage()).toBe(msg);
      });

      it('should return the subject via getSubject()', () => {
        // Given: a message with a specific subject
        const subject = faker.lorem.word();
        const sut = new RpcContext([createMock<Msg>({ subject })]);

        // Then: subject is accessible
        expect(sut.getSubject()).toBe(subject);
      });
    });

    describe('when message has headers', () => {
      it('should return headers via getHeaders()', () => {
        // Given: a message with headers
        const headers = createMock<MsgHdrs>();
        const sut = new RpcContext([createMock<Msg>({ headers })]);

        // Then: headers object returned
        expect(sut.getHeaders()).toBe(headers);
      });

      it('should return single header value via getHeader()', () => {
        // Given: a message with a specific header
        const traceId = faker.string.uuid();
        const headers = createMock<MsgHdrs>({ get: jest.fn().mockReturnValue(traceId) });
        const sut = new RpcContext([createMock<Msg>({ headers })]);

        // When: header is accessed
        const result = sut.getHeader('x-trace-id');

        // Then: value returned, correct key passed
        expect(result).toBe(traceId);
        expect(headers.get).toHaveBeenCalledWith('x-trace-id');
      });
    });
  });

  describe('edge cases', () => {
    describe('when message has no headers', () => {
      it('should return undefined from getHeaders()', () => {
        const sut = new RpcContext([createMock<Msg>({ headers: undefined })]);

        expect(sut.getHeaders()).toBeUndefined();
      });

      it('should return undefined from getHeader()', () => {
        const sut = new RpcContext([createMock<Msg>({ headers: undefined })]);

        expect(sut.getHeader('x-anything')).toBeUndefined();
      });
    });
  });

  describe('isJetStream() type guard', () => {
    describe('when message is a JsMsg', () => {
      it('should return true', () => {
        // Given: a JsMsg (has ack method as own property)
        const sut = new RpcContext([createMock<JsMsg>({ ack: jest.fn() })]);

        // Then: type guard is true
        expect(sut.isJetStream()).toBe(true);
      });
    });

    describe('when message is a core Msg', () => {
      it('should return false', () => {
        // Given: a core Msg (no ack method) — manually crafted without ack
        const msg = {
          subject: 'test',
          data: new Uint8Array(),
          headers: undefined,
        } as unknown as Msg;
        const sut = new RpcContext([msg]);

        // Then: type guard is false
        expect(sut.isJetStream()).toBe(false);
      });
    });
  });
});
