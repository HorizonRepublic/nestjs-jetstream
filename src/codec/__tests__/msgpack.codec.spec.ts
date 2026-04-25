import { describe, expect, it, vi } from 'vitest';
import { faker } from '@faker-js/faker';

import { MsgpackCodec, type PackrLike } from '../msgpack.codec';

describe(MsgpackCodec, () => {
  describe('happy path', () => {
    it('should delegate encode to the injected Packr.pack', () => {
      // Given
      const encoded = new Uint8Array([0x82, 0xa1, 0x69, 0x05]);
      const packr: PackrLike = {
        pack: vi.fn().mockReturnValue(encoded),
        unpack: vi.fn(),
      };
      const sut = new MsgpackCodec(packr);
      const data = { id: faker.number.int() };

      // When
      const result = sut.encode(data);

      // Then
      expect(packr.pack).toHaveBeenCalledWith(data);
      expect(result).toBe(encoded);
    });

    it('should delegate decode to the injected Packr.unpack', () => {
      // Given
      const decoded = { id: faker.number.int(), name: faker.person.firstName() };
      const packr: PackrLike = {
        pack: vi.fn(),
        unpack: vi.fn().mockReturnValue(decoded),
      };
      const sut = new MsgpackCodec(packr);
      const wire = new Uint8Array([0xc0]);

      // When
      const result = sut.decode(wire);

      // Then
      expect(packr.unpack).toHaveBeenCalledWith(wire);
      expect(result).toBe(decoded);
    });
  });

  describe('roundtrip', () => {
    it('should roundtrip values through a stub Packr', () => {
      // Given — minimal stub that mimics msgpackr by JSON encoding
      const stub: PackrLike = {
        pack: (data: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(data)),
        unpack: (data: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(data)),
      };
      const sut = new MsgpackCodec(stub);
      const data = { a: { b: [1, { c: faker.lorem.word() }] } };

      // When + Then
      expect(sut.decode(sut.encode(data))).toEqual(data);
    });
  });

  describe('error path', () => {
    it('should propagate errors thrown by Packr.pack', () => {
      // Given
      const packr: PackrLike = {
        pack: vi.fn().mockImplementation(() => {
          throw new Error('cannot pack');
        }),
        unpack: vi.fn(),
      };
      const sut = new MsgpackCodec(packr);

      // When + Then
      expect(() => sut.encode({})).toThrow('cannot pack');
    });

    it('should propagate errors thrown by Packr.unpack', () => {
      // Given
      const packr: PackrLike = {
        pack: vi.fn(),
        unpack: vi.fn().mockImplementation(() => {
          throw new Error('truncated frame');
        }),
      };
      const sut = new MsgpackCodec(packr);

      // When + Then
      expect(() => sut.decode(new Uint8Array())).toThrow('truncated frame');
    });
  });
});
