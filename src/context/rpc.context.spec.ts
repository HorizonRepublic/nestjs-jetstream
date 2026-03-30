import { describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { faker } from '@faker-js/faker';
import type { DeliveryInfo, JsMsg, Msg, MsgHdrs } from 'nats';

import { JetstreamHeader } from '../jetstream.constants';

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
        const headers = createMock<MsgHdrs>({ get: vi.fn().mockReturnValue(traceId) });
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
        const sut = new RpcContext([createMock<JsMsg>({ ack: vi.fn() })]);

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

  describe('JetStream metadata getters', () => {
    const createJsContext = (overrides: Partial<JsMsg> = {}): RpcContext => {
      const msg = createMock<JsMsg>({ ack: vi.fn(), ...overrides });

      return new RpcContext([msg]);
    };

    describe('when message is a JsMsg', () => {
      it('should return delivery count', () => {
        const sut = createJsContext({
          info: { deliveryCount: 3 } as DeliveryInfo,
        });

        expect(sut.getDeliveryCount()).toBe(3);
      });

      it('should return stream name', () => {
        const stream = faker.lorem.word();
        const sut = createJsContext({
          info: { stream } as DeliveryInfo,
        });

        expect(sut.getStream()).toBe(stream);
      });

      it('should return sequence number', () => {
        const sut = createJsContext({ seq: 42 });

        expect(sut.getSequence()).toBe(42);
      });

      it('should return timestamp as Date', () => {
        const timestampMs = Date.now();
        const timestampNanos = timestampMs * 1_000_000;
        const sut = createJsContext({
          info: { timestampNanos } as DeliveryInfo,
        });

        const result = sut.getTimestamp();

        expect(result).toBeInstanceOf(Date);
        expect(result!.getTime()).toBe(timestampMs);
      });

      it('should return caller name from header', () => {
        const callerName = faker.lorem.word();
        const headers = createMock<MsgHdrs>({
          get: vi
            .fn()
            .mockImplementation((key: string) =>
              key === JetstreamHeader.CallerName ? callerName : undefined,
            ),
        });
        const sut = createJsContext({ headers });

        expect(sut.getCallerName()).toBe(callerName);
      });
    });

    describe('when message is a Core Msg', () => {
      it('should return undefined for all JetStream metadata', () => {
        const msg = {
          subject: 'test',
          data: new Uint8Array(),
          headers: undefined,
        } as unknown as Msg;
        const sut = new RpcContext([msg]);

        expect(sut.getDeliveryCount()).toBeUndefined();
        expect(sut.getStream()).toBeUndefined();
        expect(sut.getSequence()).toBeUndefined();
        expect(sut.getTimestamp()).toBeUndefined();
      });
    });
  });

  describe('handler-controlled settlement', () => {
    describe('initial state', () => {
      it('should have all flags as false/undefined', () => {
        const sut = new RpcContext([createMock<Msg>()]);

        expect(sut.shouldRetry).toBe(false);
        expect(sut.retryDelay).toBeUndefined();
        expect(sut.shouldTerminate).toBe(false);
        expect(sut.terminateReason).toBeUndefined();
      });
    });

    describe('retry()', () => {
      it('should set shouldRetry flag', () => {
        const sut = new RpcContext([createMock<JsMsg>({ ack: vi.fn() })]);

        sut.retry();

        expect(sut.shouldRetry).toBe(true);
        expect(sut.retryDelay).toBeUndefined();
      });

      it('should set retryDelay when provided', () => {
        const sut = new RpcContext([createMock<JsMsg>({ ack: vi.fn() })]);

        sut.retry({ delayMs: 5_000 });

        expect(sut.shouldRetry).toBe(true);
        expect(sut.retryDelay).toBe(5_000);
      });
    });

    describe('terminate()', () => {
      it('should set shouldTerminate flag', () => {
        const sut = new RpcContext([createMock<JsMsg>({ ack: vi.fn() })]);

        sut.terminate();

        expect(sut.shouldTerminate).toBe(true);
        expect(sut.terminateReason).toBeUndefined();
      });

      it('should set terminateReason when provided', () => {
        const reason = faker.lorem.sentence();
        const sut = new RpcContext([createMock<JsMsg>({ ack: vi.fn() })]);

        sut.terminate(reason);

        expect(sut.shouldTerminate).toBe(true);
        expect(sut.terminateReason).toBe(reason);
      });
    });

    describe('when message is Core NATS', () => {
      it('should throw on retry()', () => {
        const msg = { subject: 'test', data: new Uint8Array() } as unknown as Msg;
        const sut = new RpcContext([msg]);

        expect(() => {
          sut.retry();
        }).toThrow('retry() is only available for JetStream messages');
      });

      it('should throw on terminate()', () => {
        const msg = { subject: 'test', data: new Uint8Array() } as unknown as Msg;
        const sut = new RpcContext([msg]);

        expect(() => {
          sut.terminate();
        }).toThrow('terminate() is only available for JetStream messages');
      });
    });

    describe('mutual exclusivity', () => {
      it('should throw when terminate() is called after retry()', () => {
        const sut = new RpcContext([createMock<JsMsg>({ ack: vi.fn() })]);

        sut.retry();

        expect(() => {
          sut.terminate();
        }).toThrow('Cannot terminate — retry() was already called');
      });

      it('should throw when retry() is called after terminate()', () => {
        const sut = new RpcContext([createMock<JsMsg>({ ack: vi.fn() })]);

        sut.terminate();

        expect(() => {
          sut.retry();
        }).toThrow('Cannot retry — terminate() was already called');
      });
    });
  });
});
