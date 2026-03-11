import { faker } from '@faker-js/faker';

import type { StreamKind } from './interfaces';
import {
  buildBroadcastSubject,
  buildSubject,
  consumerName,
  getClientToken,
  internalName,
  nanos,
  streamName,
} from './jetstream.constants';

describe('jetstream.constants', () => {
  describe(nanos.name, () => {
    it.each([
      [1, 1_000_000],
      [1000, 1_000_000_000],
      [0, 0],
    ])('should convert %dms to %dns', (ms, expected) => {
      expect(nanos(ms)).toBe(expected);
    });
  });

  describe(getClientToken.name, () => {
    it('should return the service name as-is', () => {
      const name = faker.lorem.word();

      expect(getClientToken(name)).toBe(name);
    });
  });

  describe(internalName.name, () => {
    it('should append __microservice suffix', () => {
      const name = faker.lorem.word();

      expect(internalName(name)).toBe(`${name}__microservice`);
    });
  });

  describe(buildSubject.name, () => {
    let serviceName: string;

    beforeEach(() => {
      serviceName = faker.lorem.word();
    });

    it('should build cmd subject', () => {
      const pattern = faker.lorem.word();

      expect(buildSubject(serviceName, 'cmd', pattern)).toBe(
        `${serviceName}__microservice.cmd.${pattern}`,
      );
    });

    it('should build ev subject', () => {
      const pattern = faker.lorem.word();

      expect(buildSubject(serviceName, 'ev', pattern)).toBe(
        `${serviceName}__microservice.ev.${pattern}`,
      );
    });
  });

  describe(buildBroadcastSubject.name, () => {
    it('should prefix with broadcast.', () => {
      const pattern = faker.lorem.word();

      expect(buildBroadcastSubject(pattern)).toBe(`broadcast.${pattern}`);
    });
  });

  describe(streamName.name, () => {
    let serviceName: string;

    beforeEach(() => {
      serviceName = faker.lorem.word();
    });

    it.each<[StreamKind, string]>([
      ['ev', 'ev-stream'],
      ['cmd', 'cmd-stream'],
    ])('should build %s stream name with service prefix', (kind, suffix) => {
      expect(streamName(serviceName, kind)).toBe(`${serviceName}__microservice_${suffix}`);
    });

    it('should return fixed name for broadcast', () => {
      expect(streamName(serviceName, 'broadcast')).toBe('broadcast-stream');
    });
  });

  describe(consumerName.name, () => {
    let serviceName: string;

    beforeEach(() => {
      serviceName = faker.lorem.word();
    });

    it.each<[StreamKind, string]>([
      ['ev', 'ev-consumer'],
      ['cmd', 'cmd-consumer'],
    ])('should build %s consumer name with service prefix', (kind, suffix) => {
      expect(consumerName(serviceName, kind)).toBe(`${serviceName}__microservice_${suffix}`);
    });

    it('should include service prefix for broadcast consumer', () => {
      expect(consumerName(serviceName, 'broadcast')).toBe(
        `${serviceName}__microservice_broadcast-consumer`,
      );
    });
  });
});
