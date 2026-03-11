import { faker } from '@faker-js/faker';

import { JsonCodec } from './json.codec';

describe(JsonCodec, () => {
  let sut: JsonCodec;

  beforeEach(() => {
    sut = new JsonCodec();
  });

  describe('happy path', () => {
    describe('when encoding and decoding an object', () => {
      it('should produce a Uint8Array and roundtrip correctly', () => {
        // Given: a plain object
        const data = { id: faker.number.int(), name: faker.person.firstName() };

        // When: encoded and decoded
        const encoded = sut.encode(data);
        const decoded = sut.decode(encoded);

        // Then: Uint8Array produced, roundtrip preserves value
        expect(encoded).toBeInstanceOf(Uint8Array);
        expect(decoded).toEqual(data);
      });
    });

    describe('when encoding primitives', () => {
      it.each([
        ['string', faker.lorem.word()],
        ['number', faker.number.int()],
        ['boolean', faker.datatype.boolean()],
        ['null', null],
      ])('should roundtrip %s correctly', (_label, value) => {
        expect(sut.decode(sut.encode(value))).toEqual(value);
      });
    });

    describe('when encoding nested structures', () => {
      it('should roundtrip nested objects and arrays', () => {
        // Given: a deeply nested structure
        const data = { a: { b: [1, { c: faker.lorem.word() }] } };

        // When/Then: roundtrip preserves structure
        expect(sut.decode(sut.encode(data))).toEqual(data);
      });
    });
  });
});
