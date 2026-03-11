import { of, EMPTY, throwError, Subject } from 'rxjs';
import { faker } from '@faker-js/faker';

import { unwrapResult } from './unwrap-result';

describe(unwrapResult.name, () => {
  describe('happy path', () => {
    describe('when result is a plain value', () => {
      it('should return the value as-is', async () => {
        // Given: a plain numeric value
        const value = faker.number.int();

        // When: unwrapped
        const result = await unwrapResult(value);

        // Then: same value returned
        expect(result).toBe(value);
      });
    });

    describe('when result is a Promise', () => {
      it('should await and return the resolved value', async () => {
        // Given: a resolved Promise
        const value = { id: faker.number.int() };

        // When: unwrapped
        const result = await unwrapResult(Promise.resolve(value));

        // Then: resolved value returned
        expect(result).toEqual(value);
      });
    });

    describe('when result is an Observable', () => {
      it('should resolve with the first emitted value', async () => {
        // Given: an Observable emitting a single value
        const value = faker.number.int();

        // When: unwrapped
        const result = await unwrapResult(of(value));

        // Then: first emitted value returned
        expect(result).toBe(value);
      });
    });
  });

  describe('edge cases', () => {
    describe('when Observable emits multiple values', () => {
      it('should resolve with only the first value', async () => {
        // Given: an Observable emitting 3 values
        const first = faker.number.int();

        // When: unwrapped
        const result = await unwrapResult(of(first, 999, 888));

        // Then: first value taken
        expect(result).toBe(first);
      });
    });

    describe('when Observable completes without emitting', () => {
      it('should resolve with undefined', async () => {
        // When: unwrapped with EMPTY observable
        const result = await unwrapResult(EMPTY);

        // Then: undefined returned
        expect(result).toBeUndefined();
      });
    });

    describe('when Observable emits asynchronously', () => {
      it('should wait for the first emission', async () => {
        // Given: a Subject that emits after unwrap is called
        const subject = new Subject<number>();
        const value = faker.number.int();

        // When: unwrapped
        const promise = unwrapResult(subject.asObservable());

        subject.next(value);
        subject.complete();

        // Then: async value returned
        expect(await promise).toBe(value);
      });
    });

    describe('when result is null', () => {
      it('should return null', async () => {
        expect(await unwrapResult(null)).toBeNull();
      });
    });
  });

  describe('NestJS handler wrapping (Promise<Observable>)', () => {
    describe('when result is Promise<Observable> (success)', () => {
      it('should await the Promise then unwrap the Observable', async () => {
        // Given: a Promise that resolves to an Observable (NestJS handler pattern)
        const value = faker.number.int();
        const result = Promise.resolve(of(value));

        // When: unwrapped
        const actual = await unwrapResult(result);

        // Then: first emitted value returned
        expect(actual).toBe(value);
      });
    });

    describe('when result is Promise<throwError> (error from exception filter)', () => {
      it('should reject with the error', async () => {
        // Given: a Promise that resolves to an error Observable
        // This is what NestJS exception filters return: throwError(() => errorObj)
        const errorObj = { status: 'error', message: 'User not found' };
        const result = Promise.resolve(throwError(() => errorObj));

        // When/Then: unwrap rejects with the error object
        await expect(unwrapResult(result)).rejects.toEqual(errorObj);
      });
    });
  });

  describe('error paths', () => {
    describe('when Observable errors', () => {
      it('should reject with the error', async () => {
        // Given: an Observable that errors
        const error = new Error(faker.lorem.sentence());

        // When/Then: unwrap rejects
        await expect(unwrapResult(throwError(() => error))).rejects.toThrow(error.message);
      });
    });
  });
});
