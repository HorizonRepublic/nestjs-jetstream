import { faker } from '@faker-js/faker';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertNoRemovedOptions } from '../removed-options';

describe('assertNoRemovedOptions', () => {
  afterEach(vi.resetAllMocks);

  it('should accept options that use only the current spelling', () => {
    // Given a configuration written against the current option shape
    const options = {
      name: faker.word.noun(),
      servers: ['nats://localhost:4222'],
      publisherOnly: true,
      provisioning: { allowDestructiveMigration: true },
      ordered: { consumer: { opt_start_seq: 10 } },
    };

    // When / Then nothing is rejected
    expect(() => {
      assertNoRemovedOptions(options);
    }).not.toThrow();
  });

  it('should accept a consumer block nested under a stream kind', () => {
    // Given the raw NATS consumer block, which shares its name with the removed root switch
    const options = { name: 'orders', events: { consumer: { max_deliver: 5 } } };

    // When / Then it is not mistaken for the removed option
    expect(() => {
      assertNoRemovedOptions(options);
    }).not.toThrow();
  });

  it('should reject the root consumer switch and name its replacement', () => {
    // Given a v2 publisher-only configuration
    const options = { name: 'gateway', consumer: false };

    // When / Then
    expect(() => {
      assertNoRemovedOptions(options);
    }).toThrow(/`consumer` .*`publisherOnly`/);
  });

  it('should reject a root allowDestructiveMigration', () => {
    // Given the v2 location of the migration flag
    const options = { name: 'orders', allowDestructiveMigration: true };

    // When / Then
    expect(() => {
      assertNoRemovedOptions(options);
    }).toThrow(/provisioning\.allowDestructiveMigration/);
  });

  it.each(['deliverPolicy', 'optStartSeq', 'optStartTime', 'replayPolicy'])(
    'should reject ordered.%s',
    (key) => {
      // Given a v2 ordered consumer option at the top of the ordered block
      const options = { name: 'orders', ordered: { [key]: 'x' } };

      // When / Then the message points into ordered.consumer
      expect(() => {
        assertNoRemovedOptions(options);
      }).toThrow(new RegExp(`ordered\\.${key}`));
    },
  );

  it('should reject removed options inside a named connection', () => {
    // Given a v2 option on one connection of a multi-connection setup
    const options = {
      name: 'orders',
      connections: { analytics: { servers: ['nats://b:4222'], consumer: false } },
    };

    // When / Then the connection is named in the message
    expect(() => {
      assertNoRemovedOptions(options);
    }).toThrow(/connections\.analytics\.consumer/);
  });

  it('should list every removed option at once', () => {
    // Given several v2 options in one configuration
    const options = {
      name: 'orders',
      consumer: true,
      allowDestructiveMigration: true,
      ordered: { replayPolicy: 'instant' },
    };

    // When
    const act = (): void => {
      assertNoRemovedOptions(options);
    };

    // Then all three are reported together
    expect(act).toThrow(/consumer[\s\S]*allowDestructiveMigration[\s\S]*ordered\.replayPolicy/);
  });
});
