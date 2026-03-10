import { JSONCodec as NatsJSONCodec } from 'nats';

import type { Codec } from '../interfaces';

/**
 * Default JSON codec wrapping the nats.js JSONCodec.
 *
 * Serializes to/from JSON using the native NATS implementation
 * which handles `TextEncoder`/`TextDecoder` internally.
 *
 * @example
 * ```typescript
 * const codec = new JsonCodec();
 * const bytes = codec.encode({ hello: 'world' });
 * const data = codec.decode(bytes); // { hello: 'world' }
 * ```
 */
export class JsonCodec implements Codec {
  private readonly inner = NatsJSONCodec();

  public encode(data: unknown): Uint8Array {
    return this.inner.encode(data);
  }

  public decode(data: Uint8Array): unknown {
    return this.inner.decode(data);
  }
}
