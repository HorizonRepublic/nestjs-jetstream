import { JetStreamApiError } from '@nats-io/jetstream';
import type { JetStreamManager, StreamInfo } from '@nats-io/jetstream';

import { createMock } from '@golevelup/ts-vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import { ConfigErrorReason } from '../../../errors';
import { ManagementMode, StreamKind } from '../../../interfaces';
import type { JetstreamModuleOptions } from '../../../interfaces';
import { STREAM_OWNER_METADATA_KEY } from '../../../jetstream.constants';
import { NatsErrorCode } from '../nats-error-codes';
import { mergeOwnedMetadata, StreamOwnership } from '../stream-ownership';

const SERVICE = 'orders';

const streamOwnedBy = (owner: string | undefined): StreamInfo =>
  createMock<StreamInfo>({
    config: { metadata: owner === undefined ? {} : { [STREAM_OWNER_METADATA_KEY]: owner } },
  });

const desiredBy = (owner: string): { name: string; metadata: Record<string, string> } => ({
  name: 'orders__microservice_ev-stream',
  metadata: { [STREAM_OWNER_METADATA_KEY]: owner },
});

describe(StreamOwnership, () => {
  let options: JetstreamModuleOptions;
  let sut: StreamOwnership;

  beforeEach(() => {
    options = { name: SERVICE, servers: ['nats://localhost:4222'] };
    sut = new StreamOwnership(options);
  });

  afterEach(vi.resetAllMocks);

  describe('stamp', () => {
    it('should stamp the service and the default connection', () => {
      expect(sut.metadataFor(StreamKind.Event)).toEqual({
        [STREAM_OWNER_METADATA_KEY]: `${SERVICE}:default`,
      });
    });

    it('should leave the shared broadcast stream unstamped', () => {
      expect(sut.metadataFor(StreamKind.Broadcast)).toBeUndefined();
    });

    it('should leave externally managed streams unstamped', () => {
      // Given
      sut = new StreamOwnership({
        ...options,
        provisioning: { management: ManagementMode.Manual },
      });

      // When / Then
      expect(sut.stamp('dlq')).toBeUndefined();
    });
  });

  describe('assertOwnership', () => {
    it('should accept a stream this connection owns', () => {
      expect(() => {
        sut.assertOwnership(streamOwnedBy(`${SERVICE}:default`), desiredBy(`${SERVICE}:default`));
      }).not.toThrow();
    });

    it('should accept a stream another service stamped', () => {
      expect(() => {
        sut.assertOwnership(streamOwnedBy('billing:default'), desiredBy(`${SERVICE}:default`));
      }).not.toThrow();
    });

    it('should refuse a stream a sibling connection owns', () => {
      expect(() => {
        sut.assertOwnership(streamOwnedBy(`${SERVICE}:eu`), desiredBy(`${SERVICE}:default`));
      }).toThrow(
        expect.objectContaining({
          name: 'JetstreamConfigError',
          reason: ConfigErrorReason.StreamOwnershipConflict,
          message: expect.stringContaining('already owned by connection "eu"'),
        }),
      );
    });
  });

  describe('rethrowAsConflict', () => {
    let jsm: Mocked<JetStreamManager>;

    beforeEach(() => {
      jsm = createMock<JetStreamManager>();
    });

    it('should report the sibling that won a create race', async () => {
      // Given
      const lost = new JetStreamApiError({
        err_code: NatsErrorCode.StreamAlreadyExists,
        code: 400,
        description: 'stream name already in use with a different configuration',
      });

      vi.mocked(jsm.streams.info).mockResolvedValue(streamOwnedBy(`${SERVICE}:eu`));

      // When / Then
      await expect(
        sut.rethrowAsConflict(jsm, desiredBy(`${SERVICE}:default`), lost),
      ).rejects.toThrow(
        expect.objectContaining({ reason: ConfigErrorReason.StreamOwnershipConflict }),
      );
    });

    it('should ignore any other create failure', async () => {
      // When
      await sut.rethrowAsConflict(jsm, desiredBy(`${SERVICE}:default`), new Error('timeout'));

      // Then
      expect(jsm.streams.info).not.toHaveBeenCalled();
    });

    it('should leave the original error in place when the re-read fails', async () => {
      // Given
      const lost = new JetStreamApiError({
        err_code: NatsErrorCode.StreamAlreadyExists,
        code: 400,
        description: 'stream name already in use',
      });

      vi.mocked(jsm.streams.info).mockRejectedValue(new Error('timeout'));

      // When / Then
      await expect(
        sut.rethrowAsConflict(jsm, desiredBy(`${SERVICE}:default`), lost),
      ).resolves.toBeUndefined();
    });
  });
});

describe(mergeOwnedMetadata, () => {
  it('should keep user metadata next to the stamp', () => {
    expect(mergeOwnedMetadata({ team: 'core' }, { owner: 'x' })).toEqual({
      team: 'core',
      owner: 'x',
    });
  });

  it('should return undefined when neither side contributes', () => {
    expect(mergeOwnedMetadata(undefined, undefined)).toBeUndefined();
  });
});
