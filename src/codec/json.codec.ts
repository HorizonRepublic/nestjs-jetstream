import type { Codec } from '../interfaces';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Default JSON codec using native `TextEncoder`/`TextDecoder`.
 *
 * Serializes values to JSON via `JSON.stringify` and encodes the
 * resulting string into a `Uint8Array`. Decoding reverses the process.
 *
 * @example
 * ```typescript
 * const codec = new JsonCodec();
 * const bytes = codec.encode({ hello: 'world' });
 * const data = codec.decode(bytes); // { hello: 'world' }
 * ```
 */
export class JsonCodec implements Codec {
  public encode(data: unknown): Uint8Array {
    return encoder.encode(JSON.stringify(data));
  }

  public decode(data: Uint8Array): unknown {
    return JSON.parse(decoder.decode(data));
  }
}
