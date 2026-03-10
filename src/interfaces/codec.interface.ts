/**
 * Codec interface for encoding and decoding message payloads.
 *
 * Implementations handle serialization between application objects and
 * binary data transmitted over NATS. The transport uses a single global
 * codec — all messages (RPC and events) share the same format.
 *
 * @example
 * ```typescript
 * import { encode, decode } from '@msgpack/msgpack';
 *
 * class MsgPackCodec implements Codec {
 *   encode(data: unknown): Uint8Array {
 *     return encode(data);
 *   }
 *   decode(data: Uint8Array): unknown {
 *     return decode(data);
 *   }
 * }
 * ```
 */
export interface Codec {
  /** Serialize application data to binary for NATS transmission. */
  encode(data: unknown): Uint8Array;

  /** Deserialize binary NATS payload back to application data. */
  decode(data: Uint8Array): unknown;
}
