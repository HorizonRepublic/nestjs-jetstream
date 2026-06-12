import type { WritePacket } from '@nestjs/microservices';

/** Settles one pending RPC round-trip with its reply or error packet. */
export type RpcReplyCallback = (packet: WritePacket) => void;

/** The slice of a JetStream publish ack the client inspects for dedup warnings. */
export interface PublishAckLike {
  readonly duplicate: boolean;
  readonly seq: number;
}
