import { describe, expect, it } from 'vitest';
import { RpcException } from '@nestjs/microservices';
import { faker } from '@faker-js/faker';

import { serializeError } from '../serialize-error';

describe(serializeError.name, () => {
  describe('happy path', () => {
    describe('when error is a plain object (pre-unwrapped by NestJS)', () => {
      it('should pass the object through as-is', () => {
        // Given: a plain error payload already unwrapped by NestJS exception filter
        const payload = { statusCode: 400, message: faker.lorem.sentence() };

        // When: serialized
        const result = serializeError(payload);

        // Then: identical reference returned
        expect(result).toBe(payload);
      });
    });

    describe('when error is a generic Error', () => {
      it('should extract message into an object', () => {
        // Given: a standard Error instance
        const message = faker.lorem.sentence();
        const error = new Error(message);

        // When: serialized
        const result = serializeError(error);

        // Then: message property is extracted
        expect(result).toEqual({ message });
      });
    });

    describe('when error is an RpcException', () => {
      it('should unwrap object payload via getError()', () => {
        // Given: an RpcException with an object payload
        const payload = { statusCode: 422, message: faker.lorem.sentence() };
        const exception = new RpcException(payload);

        // When: serialized
        const result = serializeError(exception);

        // Then: original payload is preserved
        expect(result).toEqual(payload);
      });

      it('should unwrap string payload via getError()', () => {
        // Given: an RpcException with a string payload
        const message = faker.lorem.sentence();
        const exception = new RpcException(message);

        // When: serialized
        const result = serializeError(exception);

        // Then: string payload returned
        expect(result).toBe(message);
      });
    });
  });

  describe('edge cases', () => {
    describe('when error is a string', () => {
      it('should pass through as-is', () => {
        const value = faker.lorem.word();

        expect(serializeError(value)).toBe(value);
      });
    });

    describe('when error is null or undefined', () => {
      it.each([null, undefined])('should pass %s through as-is', (value) => {
        expect(serializeError(value)).toBe(value);
      });
    });
  });

  describe('error paths', () => {
    describe('when RpcException competes with Error instanceof check', () => {
      it('should prefer RpcException branch over Error branch', () => {
        // Given: RpcException extends Error, both instanceof checks would match
        const payload = { statusCode: 400, message: faker.lorem.sentence() };
        const exception = new RpcException(payload);

        // When: serialized
        const result = serializeError(exception);

        // Then: getError() is used, not { message: err.message }
        expect(result).toEqual(payload);
        expect(result).not.toEqual({ message: exception.message });
      });
    });
  });
});
