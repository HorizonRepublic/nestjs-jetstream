import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { JetstreamBindingError } from '../binding-error';
import { JetstreamConfigError } from '../config-error';
import { JetstreamConnectionError } from '../connection-error';
import {
  BindingErrorReason,
  ConfigErrorReason,
  ConnectionErrorReason,
  MigrationErrorReason,
  RecordErrorReason,
  RpcErrorReason,
} from '../errors.types';
import { isJetstreamError, JETSTREAM_ERROR_BRAND } from '../jetstream-error';
import { JetstreamMigrationError } from '../migration-error';
import { JetstreamRecordError } from '../record-error';
import { JetstreamRpcError } from '../rpc-error';

describe('typed errors', () => {
  it.each([
    [new JetstreamConfigError(ConfigErrorReason.DuplicateHandler, 'm'), JetstreamConfigError],
    [
      new JetstreamConnectionError(ConnectionErrorReason.NotConnected, 'm'),
      JetstreamConnectionError,
    ],
    [new JetstreamRecordError(RecordErrorReason.InvalidTtl, 'm'), JetstreamRecordError],
    [new JetstreamRpcError(RpcErrorReason.SettlementConflict, 'm'), JetstreamRpcError],
    [new JetstreamBindingError(BindingErrorReason.DlqSubjectMismatch, 'm'), JetstreamBindingError],
    [new JetstreamMigrationError(MigrationErrorReason.SharedStream, 'm'), JetstreamMigrationError],
  ])('should build %o as a branded Error named after its class', (sut, type) => {
    // Then
    expect(sut).toBeInstanceOf(type);
    expect(sut).toBeInstanceOf(Error);
    expect(sut.name).toBe(type.name);
    expect(sut.message).toBe('m');
    expect(isJetstreamError(sut)).toBe(true);
  });

  it('should carry the reason it was built with', () => {
    // When
    const sut = new JetstreamConfigError(ConfigErrorReason.DuplicateHandler, 'm');

    // Then
    expect(sut.reason).toBe(ConfigErrorReason.DuplicateHandler);
  });

  it('should keep the message and cause verbatim', () => {
    // Given
    const message = faker.lorem.sentence();
    const cause = new Error(faker.lorem.word());

    // When
    const sut = new JetstreamConnectionError(ConnectionErrorReason.Refused, message, { cause });

    // Then
    expect(sut.message).toBe(message);
    expect(sut.cause).toBe(cause);
  });

  it('should recognize an error branded by another copy of the module', () => {
    // Given
    const foreign = Object.assign(new Error('m'), {
      reason: ConfigErrorReason.DuplicateHandler,
      [JETSTREAM_ERROR_BRAND]: true,
    });

    // When / Then
    expect(isJetstreamError(foreign)).toBe(true);
  });

  it.each([
    ['a plain Error', new Error('m')],
    ['null', null],
    ['a string', 'm'],
    ['an object with a reason', { reason: ConfigErrorReason.DuplicateHandler }],
  ])('should not recognize %s', (_label, value) => {
    expect(isJetstreamError(value)).toBe(false);
  });
});
