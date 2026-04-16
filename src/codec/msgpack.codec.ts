import type { Codec } from '../interfaces';

/**
 * Minimal shape of a `msgpackr` `Packr` instance used by {@link MsgpackCodec}.
 *
 * Typed locally so consumers who do not use MessagePack encoding never pay
 * for a `msgpackr` import.
 */
export interface PackrLike {
  pack(data: unknown): Uint8Array;
  unpack(data: Uint8Array): unknown;
}

/**
 * MessagePack codec backed by a caller-provided `msgpackr` `Packr` instance.
 *
 * Use this codec when publishing structured payloads larger than roughly
 * 1–2 KB — below that size the default {@link JsonCodec} wins on per-call
 * constant overhead. Above it, MessagePack encodes and decodes several times
 * faster and produces smaller wire frames. The format is cross-language, so
 * Node producers and non-Node consumers (Python, Go, Java, Rust, ...) stay
 * interoperable.
 *
 * Requires installing the optional `msgpackr` peer dependency:
 *
 * ```bash
 * npm install msgpackr
 * # or: pnpm add msgpackr
 * ```
 *
 * @example
 * ```typescript
 * import { JetstreamModule, MsgpackCodec } from '@horizon-republic/nestjs-jetstream';
 * import { Packr } from 'msgpackr';
 *
 * JetstreamModule.forRoot({
 *   name: 'orders',
 *   servers: ['nats://localhost:4222'],
 *   codec: new MsgpackCodec(new Packr()),
 * });
 * ```
 */
export class MsgpackCodec implements Codec {
  public constructor(private readonly packr: PackrLike) {}

  public encode(data: unknown): Uint8Array {
    return this.packr.pack(data);
  }

  public decode(data: Uint8Array): unknown {
    return this.packr.unpack(data);
  }
}
