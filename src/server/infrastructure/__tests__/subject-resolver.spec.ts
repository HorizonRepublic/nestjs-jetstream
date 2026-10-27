import { faker } from '@faker-js/faker';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigErrorReason } from '../../../errors';
import { StreamKind } from '../../../interfaces';
import { buildSubject, internalName } from '../../../jetstream.constants';
import { SubjectResolver } from '../subject-resolver';

describe(SubjectResolver, () => {
  afterEach(vi.resetAllMocks);

  describe('forService', () => {
    it('should follow the naming convention when no prefix is set', () => {
      // Given
      const name = faker.lorem.word();

      // When
      const sut = SubjectResolver.forService(name, {});

      // Then
      expect(sut.subject(StreamKind.Event, 'a.b')).toBe(
        buildSubject(name, StreamKind.Event, 'a.b'),
      );
      expect(sut.subject(StreamKind.Broadcast, 'a.b')).toBe('broadcast.a.b');
      expect(sut.schedulePrefix(StreamKind.Event)).toBe(`${internalName(name)}._sch.`);
      expect(sut.hasCustomPrefix(StreamKind.Event)).toBe(false);
    });

    it('should normalize a custom prefix and nest schedules under it', () => {
      // Given
      const prefix = `${faker.lorem.word()}.orders`;

      // When
      const sut = SubjectResolver.forService('svc', { [StreamKind.Event]: `${prefix}..` });

      // Then
      expect(sut.subject(StreamKind.Event, 'created')).toBe(`${prefix}.created`);
      expect(sut.filterSubject(StreamKind.Event)).toBe(`${prefix}.>`);
      expect(sut.schedulePrefix(StreamKind.Event)).toBe(`${prefix}._sch.`);
      expect(sut.hasCustomPrefix(StreamKind.Event)).toBe(true);
    });

    it.each(['', '...', 'a..b', 'a.>'])('should reject the prefix "%s"', (prefix) => {
      // When / Then
      expect(() => SubjectResolver.forService('svc', { [StreamKind.Command]: prefix })).toThrow(
        expect.objectContaining({
          name: 'JetstreamConfigError',
          reason: ConfigErrorReason.InvalidSubjectPrefix,
          message: expect.stringMatching(/Invalid subjectPrefix/),
        }),
      );
    });
  });

  describe('forTarget', () => {
    it("should take the target's prefixes and the caller's broadcast prefix", () => {
      // Given
      const caller = SubjectResolver.forService('caller', { [StreamKind.Broadcast]: 'acme.bc' });

      // When
      const sut = SubjectResolver.forTarget('asset', { [StreamKind.Event]: 'acme.ev' }, caller);

      // Then
      expect(sut.subject(StreamKind.Event, 'x')).toBe('acme.ev.x');
      expect(sut.subject(StreamKind.Ordered, 'x')).toBe(
        buildSubject('asset', StreamKind.Ordered, 'x'),
      );
      expect(sut.subject(StreamKind.Broadcast, 'x')).toBe('acme.bc.x');
    });
  });

  describe('scheduleSubjectBase', () => {
    it('should map an event subject to its schedule holder base', () => {
      // Given
      const sut = SubjectResolver.forService('svc', { [StreamKind.Event]: 'acme.ev' });

      // When / Then
      expect(sut.scheduleSubjectBase('acme.ev.order.reminder')).toBe('acme.ev._sch.order.reminder');
    });

    it('should reject a subject no event kind produced', () => {
      // Given
      const sut = SubjectResolver.forService('svc', {});

      // When / Then
      expect(() => sut.scheduleSubjectBase('elsewhere.order')).toThrow(
        /Unexpected event subject format/,
      );
    });
  });
});
