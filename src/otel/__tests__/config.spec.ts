import { afterEach, describe, expect, it, vi } from 'vitest';
import { faker } from '@faker-js/faker';
import { HttpException, NotFoundException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { resolveOtelOptions } from '../config';
import { JetstreamTrace, DEFAULT_TRACES } from '../trace-kinds';

describe('resolveOtelOptions', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('defaults', () => {
    it('should apply enabled=true when no options are provided', () => {
      // When
      const sut = resolveOtelOptions();

      // Then
      expect(sut.enabled).toBe(true);
    });

    it('should default traces to the DEFAULT_TRACES set', () => {
      // When
      const sut = resolveOtelOptions();

      // Then
      expect([...sut.traces]).toEqual([...DEFAULT_TRACES]);
    });

    it('should default captureBody to false', () => {
      // When
      const sut = resolveOtelOptions();

      // Then
      expect(sut.captureBody).toBe(false);
    });

    it('should compile a captureHeaders matcher that allows the default correlation headers', () => {
      // When
      const sut = resolveOtelOptions();

      // Then
      expect(sut.captureHeaders('x-request-id')).toBe(true);
      expect(sut.captureHeaders('X-Request-Id')).toBe(true);
      expect(sut.captureHeaders('authorization')).toBe(false);
    });
  });

  describe('traces option', () => {
    it('should expand the "default" preset to DEFAULT_TRACES', () => {
      // When
      const sut = resolveOtelOptions({ traces: 'default' });

      // Then
      expect([...sut.traces]).toEqual([...DEFAULT_TRACES]);
    });

    it('should expand the "all" preset to every JetstreamTrace value', () => {
      // When
      const sut = resolveOtelOptions({ traces: 'all' });

      // Then
      expect([...sut.traces]).toEqual(Object.values(JetstreamTrace));
    });

    it('should expand the "none" preset to an empty set', () => {
      // When
      const sut = resolveOtelOptions({ traces: 'none' });

      // Then
      expect(sut.traces.size).toBe(0);
    });

    it('should accept an explicit array of JetstreamTrace values', () => {
      // Given
      const explicit = [JetstreamTrace.Publish, JetstreamTrace.ConnectionLifecycle];

      // When
      const sut = resolveOtelOptions({ traces: explicit });

      // Then
      expect([...sut.traces]).toEqual(explicit);
    });
  });

  describe('captureBody', () => {
    it('should resolve true to a maxBytes default of 4096', () => {
      // When
      const sut = resolveOtelOptions({ captureBody: true });

      // Then
      expect(sut.captureBody).toEqual({ maxBytes: 4096 });
    });

    it('should preserve a user-supplied maxBytes', () => {
      // Given
      const maxBytes = faker.number.int({ min: 1, max: 65_536 });

      // When
      const sut = resolveOtelOptions({ captureBody: { maxBytes } });

      // Then
      expect(sut.captureBody).toEqual({ maxBytes, subjectAllowlist: undefined });
    });

    it('should pass through a subject allowlist verbatim', () => {
      // Given
      const subjectAllowlist = ['orders.*', 'inventory.*'];

      // When
      const sut = resolveOtelOptions({ captureBody: { maxBytes: 1024, subjectAllowlist } });

      // Then
      expect(sut.captureBody).toEqual({ maxBytes: 1024, subjectAllowlist });
    });
  });

  describe('errorClassifier', () => {
    it('should default-classify RpcException as expected', () => {
      // Given
      const sut = resolveOtelOptions();
      const err = new RpcException({ code: 'NOT_AUTHORIZED' });

      // When + Then
      expect(sut.errorClassifier(err)).toBe('expected');
    });

    it('should default-classify HttpException as expected', () => {
      // Given
      const sut = resolveOtelOptions();
      const err = new HttpException('forbidden', 403);

      // When + Then
      expect(sut.errorClassifier(err)).toBe('expected');
    });

    it('should default-classify NestJS HttpException subclasses (NotFoundException) as expected', () => {
      // Given
      const sut = resolveOtelOptions();
      const err = new NotFoundException('missing');

      // When + Then
      expect(sut.errorClassifier(err)).toBe('expected');
    });

    it('should default-classify bare Error as unexpected', () => {
      // Given
      const sut = resolveOtelOptions();
      const err = new Error(faker.lorem.sentence());

      // When + Then
      expect(sut.errorClassifier(err)).toBe('unexpected');
    });

    it('should default-classify primitive throws as unexpected', () => {
      // Given
      const sut = resolveOtelOptions();

      // When + Then
      expect(sut.errorClassifier('boom')).toBe('unexpected');
      expect(sut.errorClassifier(null)).toBe('unexpected');
    });

    it('should default-classify NestJS-unwrapped RpcException payload (plain object) as expected', () => {
      // Given — this is what the consume span actually sees after the NestJS
      // observable pipeline unwraps `RpcException.getError()`
      const sut = resolveOtelOptions();
      const payload = { code: 'NOT_AUTHORIZED', message: 'denied' };

      // When + Then
      expect(sut.errorClassifier(payload)).toBe('expected');
    });

    it('should default-classify the NestJS bare-Error sentinel as unexpected', () => {
      // Given — NestJS converts a bare `throw new Error(...)` from a
      // @MessagePattern handler into this exact sentinel before our catch path
      const sut = resolveOtelOptions();
      const sentinel = { status: 'error', message: 'Internal server error' };

      // When + Then
      expect(sut.errorClassifier(sentinel)).toBe('unexpected');
    });

    it('should honor a user-supplied classifier', () => {
      // Given
      const errorClassifier = vi.fn().mockReturnValue('expected' as const);
      const sut = resolveOtelOptions({ errorClassifier });
      const err = new Error('anything');

      // When
      const result = sut.errorClassifier(err);

      // Then
      expect(result).toBe('expected');
      expect(errorClassifier).toHaveBeenCalledWith(err);
    });
  });

  describe('captureHeaders', () => {
    it('should compile true into a match-all matcher', () => {
      // When
      const sut = resolveOtelOptions({ captureHeaders: true });

      // Then
      expect(sut.captureHeaders(faker.lorem.word())).toBe(true);
    });

    it('should compile false into a match-none matcher', () => {
      // When
      const sut = resolveOtelOptions({ captureHeaders: false });

      // Then
      expect(sut.captureHeaders('x-correlation-id')).toBe(false);
    });

    it('should compile glob patterns with wildcards and exclusion', () => {
      // Given
      const sut = resolveOtelOptions({ captureHeaders: ['x-*', '!x-internal-*'] });

      // When + Then
      expect(sut.captureHeaders('X-Tenant-Id')).toBe(true);
      expect(sut.captureHeaders('x-internal-secret')).toBe(false);
      expect(sut.captureHeaders('authorization')).toBe(false);
    });
  });
});
