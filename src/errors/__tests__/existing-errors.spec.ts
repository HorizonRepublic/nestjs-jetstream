import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { JetstreamCapabilityError } from '../../connection/server-capabilities';
import { CapabilityErrorReason, NatsCapability } from '../../connection/server-capabilities.types';
import { JetstreamScheduleError } from '../../schedule/schedule-error';
import { ScheduleErrorReason } from '../../schedule/schedule.types';
import { NatsErrorCode } from '../../server/infrastructure/nats-error-codes';
import { JetstreamProvisioningError } from '../../server/infrastructure/provisioning-error';
import { ProvisioningErrorReason } from '../../server/infrastructure/provisioning-error.types';
import { isJetstreamError, JetstreamError } from '../jetstream-error';

const provisioningError = (errCode: number): JetstreamProvisioningError =>
  new JetstreamProvisioningError({
    entity: 'stream',
    target: faker.lorem.word(),
    kind: 'ev',
    errCode,
    errDescription: faker.lorem.sentence(),
    remediation: faker.lorem.sentence(),
    cause: new Error(),
  });

describe('existing error classes', () => {
  it('should brand JetstreamScheduleError and keep its reason', () => {
    // When
    const sut = new JetstreamScheduleError(ScheduleErrorReason.InvalidCron, 'm');

    // Then
    expect(sut).toBeInstanceOf(JetstreamError);
    expect(isJetstreamError(sut)).toBe(true);
    expect(sut.reason).toBe(ScheduleErrorReason.InvalidCron);
    expect(sut.name).toBe('JetstreamScheduleError');
  });

  it('should brand JetstreamCapabilityError with a server-too-old reason', () => {
    // When
    const sut = new JetstreamCapabilityError(NatsCapability.MessageTtl, 1, 0, 'm');

    // Then
    expect(sut).toBeInstanceOf(JetstreamError);
    expect(isJetstreamError(sut)).toBe(true);
    expect(sut.reason).toBe(CapabilityErrorReason.ServerTooOld);
    expect(sut).toMatchObject({
      name: 'JetstreamCapabilityError',
      capability: NatsCapability.MessageTtl,
      requiredLevel: 1,
      actualLevel: 0,
      message: 'm',
    });
  });

  it.each([
    [NatsErrorCode.StorageResourcesExceeded, ProvisioningErrorReason.StorageExceeded],
    [NatsErrorCode.NoSuitablePeers, ProvisioningErrorReason.NoSuitablePeers],
    [NatsErrorCode.StreamNotFound, ProvisioningErrorReason.ServerRejected],
  ])('should derive the provisioning reason from err_code %i', (errCode, reason) => {
    // When
    const sut = provisioningError(errCode);

    // Then
    expect(sut).toBeInstanceOf(JetstreamError);
    expect(isJetstreamError(sut)).toBe(true);
    expect(sut.reason).toBe(reason);
    expect(sut.errCode).toBe(errCode);
  });
});
