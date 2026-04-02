import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetentionPolicy, StorageType } from '@nats-io/jetstream';
import type { StreamConfig } from '@nats-io/jetstream';
import { faker } from '@faker-js/faker';

import { compareStreamConfig } from './stream-config-diff';

describe(compareStreamConfig.name, () => {
  afterEach(vi.resetAllMocks);

  describe('no changes', () => {
    it('should return hasChanges: false when configs are identical', () => {
      // Given
      const config: Partial<StreamConfig> = {
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        max_age: faker.number.int({ min: 1_000_000, max: 999_000_000_000 }),
        num_replicas: 1,
      };

      // When
      const result = compareStreamConfig(config, config);

      // Then
      expect(result.hasChanges).toBe(false);
      expect(result.changes).toHaveLength(0);
    });
  });

  describe('mutable changes', () => {
    it('should classify max_age change as mutable', () => {
      // Given
      const currentAge = faker.number.int({ min: 1_000_000, max: 100_000_000_000 });
      const desiredAge = currentAge + faker.number.int({ min: 1_000_000, max: 100_000_000_000 });
      const current: Partial<StreamConfig> = { max_age: currentAge, storage: StorageType.File };
      const desired: Partial<StreamConfig> = { max_age: desiredAge, storage: StorageType.File };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasChanges).toBe(true);
      expect(result.hasMutableChanges).toBe(true);
      expect(result.hasImmutableChanges).toBe(false);
      expect(result.changes).toHaveLength(1);

      expect(result.changes[0]).toEqual({
        property: 'max_age',
        current: currentAge,
        desired: desiredAge,
        mutability: 'mutable',
      });
    });

    it('should classify num_replicas change as mutable', () => {
      // Given
      const current: Partial<StreamConfig> = { num_replicas: 1, storage: StorageType.File };
      const desired: Partial<StreamConfig> = { num_replicas: 3, storage: StorageType.File };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasMutableChanges).toBe(true);
      expect(result.hasImmutableChanges).toBe(false);
    });
  });

  describe('immutable changes', () => {
    it('should classify storage change as immutable', () => {
      // Given
      const current: Partial<StreamConfig> = { storage: StorageType.File };
      const desired: Partial<StreamConfig> = { storage: StorageType.Memory };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasImmutableChanges).toBe(true);

      expect(result.changes[0]).toEqual({
        property: 'storage',
        current: StorageType.File,
        desired: StorageType.Memory,
        mutability: 'immutable',
      });
    });
  });

  describe('transport-controlled changes', () => {
    it('should classify retention change as transport-controlled', () => {
      // Given
      const current: Partial<StreamConfig> = { retention: RetentionPolicy.Workqueue };
      const desired: Partial<StreamConfig> = { retention: RetentionPolicy.Limits };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasTransportControlledConflicts).toBe(true);
      expect(result.hasImmutableChanges).toBe(false);
      expect(result.changes[0]!.mutability).toBe('transport-controlled');
    });
  });

  describe('enable-only changes', () => {
    const enableOnlyProperties: (keyof StreamConfig)[] = [
      'allow_msg_schedules',
      'allow_msg_ttl',
      'deny_delete',
      'deny_purge',
    ];

    it.each(enableOnlyProperties)('should classify %s false→true as enable-only', (property) => {
      // Given
      const current: Partial<StreamConfig> = { [property]: false };
      const desired: Partial<StreamConfig> = { [property]: true };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasMutableChanges).toBe(true);
      expect(result.hasImmutableChanges).toBe(false);
      expect(result.changes[0]!.mutability).toBe('enable-only');
    });

    it.each(enableOnlyProperties)('should classify %s true→false as immutable', (property) => {
      // Given
      const current: Partial<StreamConfig> = { [property]: true };
      const desired: Partial<StreamConfig> = { [property]: false };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasImmutableChanges).toBe(true);
      expect(result.changes[0]!.mutability).toBe('immutable');
    });
  });

  describe('equality edge cases', () => {
    it('should detect no changes for structurally equal but distinct objects', () => {
      // Given
      const current: Partial<StreamConfig> = { storage: StorageType.File, max_age: 100 };
      const desired: Partial<StreamConfig> = { storage: StorageType.File, max_age: 100 };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasChanges).toBe(false);
    });

    it('should detect no changes when both values are null', () => {
      // Given
      const current = { max_age: null } as unknown as Partial<StreamConfig>;
      const desired = { max_age: null } as unknown as Partial<StreamConfig>;

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasChanges).toBe(false);
    });

    it('should detect change when current is undefined and desired has a value', () => {
      // Given
      const current: Partial<StreamConfig> = {};
      const desired: Partial<StreamConfig> = { max_age: 100 };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasChanges).toBe(true);
      expect(result.changes[0]!.current).toBeUndefined();
    });

    it('should treat subjects arrays with same elements as equal', () => {
      // Given
      const current: Partial<StreamConfig> = { subjects: ['a.>', 'b.>'] };
      const desired: Partial<StreamConfig> = { subjects: ['a.>', 'b.>'] };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasChanges).toBe(false);
    });
  });

  describe('mixed changes', () => {
    it('should detect both mutable and immutable in one diff', () => {
      // Given
      const current: Partial<StreamConfig> = { storage: StorageType.File, max_age: 100 };
      const desired: Partial<StreamConfig> = { storage: StorageType.Memory, max_age: 200 };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasMutableChanges).toBe(true);
      expect(result.hasImmutableChanges).toBe(true);
      expect(result.changes).toHaveLength(2);
    });

    it('should detect enable-only + immutable in one diff', () => {
      // Given
      const current: Partial<StreamConfig> = {
        storage: StorageType.File,
        allow_msg_schedules: false,
      };
      const desired: Partial<StreamConfig> = {
        storage: StorageType.Memory,
        allow_msg_schedules: true,
      };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasMutableChanges).toBe(true);
      expect(result.hasImmutableChanges).toBe(true);

      const storageChange = result.changes.find((c) => c.property === 'storage');
      const scheduleChange = result.changes.find((c) => c.property === 'allow_msg_schedules');

      expect(storageChange!.mutability).toBe('immutable');
      expect(scheduleChange!.mutability).toBe('enable-only');
    });
  });

  describe('server-managed fields', () => {
    it('should ignore fields not present in desired config', () => {
      // Given: current has server-managed fields, desired does not
      const current = {
        storage: StorageType.File,
        max_age: 100,
      } as Partial<StreamConfig>;

      const desired: Partial<StreamConfig> = { storage: StorageType.File, max_age: 100 };

      // When
      const result = compareStreamConfig(current, desired);

      // Then
      expect(result.hasChanges).toBe(false);
    });
  });
});
